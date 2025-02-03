/**
 * This file contains a diffing algorithm that is used to update the DOM
 * inspired by the set-dom library https://github.com/DylanPiercey/set-dom
 * but using HTML streaming and View Transition API.
 */
type Walker = {
  root: Node | null;
  [FIRST_CHILD]: (node: Node) => Promise<Node | null>;
  [NEXT_SIBLING]: (node: Node) => Promise<Node | null>;
  [APPLY_TRANSITION]: (v: () => void) => void;
};

type NextNodeCallback = (node: Node) => void;

type Options = {
  onNextNode?: NextNodeCallback;
  transition?: boolean;
  shouldIgnoreNode?: (node: Node | null) => boolean;
};

const ELEMENT_TYPE = 1;
const DOCUMENT_TYPE = 9;
const DOCUMENT_FRAGMENT_TYPE = 11;
const APPLY_TRANSITION = 0;
const FIRST_CHILD = 1;
const NEXT_SIBLING = 2;
const SPECIAL_TAGS = new Set(["HTML", "HEAD", "BODY"]);
const wait = () => new Promise((resolve) => requestAnimationFrame(resolve));

export default async function diff(
  oldNode: Node,
  stream: ReadableStream,
  options?: Options,
) {
  const walker = await htmlStreamWalker(stream, options);
  const newNode = walker.root!;

  if (oldNode.nodeType === DOCUMENT_TYPE) {
    oldNode = (oldNode as Document).documentElement;
  }

  if (newNode.nodeType === DOCUMENT_FRAGMENT_TYPE) {
    await setChildNodes(oldNode, newNode, walker);
  } else {
    await updateNode(oldNode, newNode, walker);
  }
}

/**
 * Updates a specific htmlNode and does whatever it takes to convert it to another one.
 */
async function updateNode(oldNode: Node, newNode: Node, walker: Walker) {
  if (oldNode.nodeType !== newNode.nodeType) {
    return walker[APPLY_TRANSITION](() =>
      oldNode.parentNode!.replaceChild(newNode.cloneNode(true), oldNode),
    );
  }

  if (oldNode.nodeType === ELEMENT_TYPE) {
    await setChildNodes(oldNode, newNode, walker);

    walker[APPLY_TRANSITION](() => {
      if (oldNode.nodeName === newNode.nodeName) {
        if (newNode.nodeName !== "BODY") {
          setAttributes(
            (oldNode as Element).attributes,
            (newNode as Element).attributes,
          );
        }
      } else {
        const hasDocumentFragmentInside = newNode.nodeName === "TEMPLATE";
        const clonedNewNode = newNode.cloneNode(hasDocumentFragmentInside);
        while (oldNode.firstChild)
          clonedNewNode.appendChild(oldNode.firstChild);
        oldNode.parentNode!.replaceChild(clonedNewNode, oldNode);
      }
    });
  } else if (oldNode.nodeValue !== newNode.nodeValue) {
    walker[APPLY_TRANSITION](() => (oldNode.nodeValue = newNode.nodeValue));
  }
}

/**
 * Utility that will update one list of attributes to match another.
 */
function setAttributes(
  oldAttributes: NamedNodeMap,
  newAttributes: NamedNodeMap,
) {
  let i, oldAttribute, newAttribute, namespace, name;

  // Remove old attributes.
  for (i = oldAttributes.length; i--; ) {
    oldAttribute = oldAttributes[i];
    namespace = oldAttribute.namespaceURI;
    name = oldAttribute.localName;
    newAttribute = newAttributes.getNamedItemNS(namespace, name);

    if (!newAttribute) oldAttributes.removeNamedItemNS(namespace, name);
  }

  // Set new attributes.
  for (i = newAttributes.length; i--; ) {
    oldAttribute = newAttributes[i];
    namespace = oldAttribute.namespaceURI;
    name = oldAttribute.localName;
    newAttribute = oldAttributes.getNamedItemNS(namespace, name);

    // Avoid register already registered server action in frameworks like Brisa
    if (oldAttribute.name === "data-action") continue;

    if (!newAttribute) {
      // Add a new attribute.
      newAttributes.removeNamedItemNS(namespace, name);
      oldAttributes.setNamedItemNS(oldAttribute);
    } else if (newAttribute.value !== oldAttribute.value) {
      // Update existing attribute.
      newAttribute.value = oldAttribute.value;
    }
  }
}

/**
 * Utility that will nodes childern to match another nodes children.
 */
async function setChildNodes(oldParent: Node, newParent: Node, walker: Walker) {
  let checkOld;
  let oldKey;
  let newKey;
  let foundNode;
  let keyedNodes: Record<string, Node> | null = null;
  let oldNode = oldParent.firstChild;
  let newNode = await walker[FIRST_CHILD](newParent);
  let extra = 0;

  // Extract keyed nodes from previous children and keep track of total count.
  while (oldNode) {
    extra++;
    checkOld = oldNode;
    oldKey = getKey(checkOld);
    oldNode = oldNode.nextSibling;

    if (oldKey) {
      if (!keyedNodes) keyedNodes = {};
      keyedNodes[oldKey] = checkOld;
    }
  }

  oldNode = oldParent.firstChild;

  // Loop over new nodes and perform updates.
  while (newNode) {
    let insertedNode;

    if (
      keyedNodes &&
      (newKey = getKey(newNode)) &&
      (foundNode = keyedNodes[newKey])
    ) {
      delete keyedNodes[newKey];
      if (foundNode !== oldNode) {
        walker[APPLY_TRANSITION](() =>
          oldParent.insertBefore(foundNode!, oldNode),
        );
      } else {
        oldNode = oldNode.nextSibling;
      }

      await updateNode(foundNode, newNode, walker);
    } else if (oldNode) {
      checkOld = oldNode;
      oldNode = oldNode.nextSibling;
      if (getKey(checkOld)) {
        insertedNode = newNode.cloneNode(true);
        walker[APPLY_TRANSITION](() =>
          oldParent.insertBefore(insertedNode!, checkOld!),
        );
      } else {
        await updateNode(checkOld, newNode, walker);
      }
    } else {
      insertedNode = newNode.cloneNode(true);
      walker[APPLY_TRANSITION](() => oldParent.appendChild(insertedNode!));
    }

    newNode = (await walker[NEXT_SIBLING](newNode)) as ChildNode;

    // If we didn't insert a node this means we are updating an existing one, so we
    // need to decrement the extra counter, so we can skip removing the old node.
    if (!insertedNode) extra--;
  }

  walker[APPLY_TRANSITION](() => {
    // Remove old keyed nodes.
    for (oldKey in keyedNodes) {
      extra--;
      oldParent.removeChild(keyedNodes![oldKey]!);
    }

    // If we have any remaining unkeyed nodes remove them from the end.
    while (--extra >= 0) oldParent.removeChild(oldParent.lastChild!);
  });
}

function getKey(node: Node) {
  return (node as Element)?.getAttribute?.("key") || (node as Element).id;
}

/**
 * Utility that will walk a html stream and call a callback for each node.
 */
async function htmlStreamWalker(
  stream: ReadableStream,
  options: Options = {},
): Promise<Walker> {
  const doc = document.implementation.createHTMLDocument();

  doc.open();
  const decoderStream = new TextDecoderStream();
  const decoderStreamReader = decoderStream.readable.getReader();
  let streamInProgress = true;

  stream.pipeTo(decoderStream.writable);
  processStream();

  async function processStream() {
    try {
      while (true) {
        const { done, value } = await decoderStreamReader.read();
        if (done) {
          streamInProgress = false;
          break;
        }

        doc.write(value);
      }
    } finally {
      doc.close();
    }
  }

  while (!doc.documentElement || isLastNodeOfChunk(doc.documentElement)) {
    await wait();
  }

  function next(field: "firstChild" | "nextSibling") {
    return async (node: Node) => {
      if (!node) return null;

      let nextNode = node[field];

      while (options.shouldIgnoreNode?.(nextNode)) {
        nextNode = nextNode![field];
      }

      if (nextNode) options.onNextNode?.(nextNode);

      const waitChildren = field === "firstChild";

      while (isLastNodeOfChunk(nextNode as Element, waitChildren)) {
        await wait();
      }

      return nextNode;
    };
  }

  function isLastNodeOfChunk(node: Node, waitChildren?: boolean) {
    if (!node || !streamInProgress || node.nextSibling) {
      return false;
    }

    if (SPECIAL_TAGS.has(node.nodeName)) {
      return !doc.body?.hasChildNodes?.();
    }

    let parent = node.parentElement;

    while (parent) {
      if (parent.nextSibling) return false;
      parent = parent.parentElement;
    }

    // Related issues to this ternary (hard to reproduce in a test):
    // https://github.com/brisa-build/diff-dom-streaming/pull/15
    // https://github.com/brisa-build/brisa/issues/739
    return waitChildren
      ? streamInProgress && !node.hasChildNodes?.()
      : streamInProgress
  }

  return {
    root: doc.documentElement,
    [FIRST_CHILD]: next("firstChild"),
    [NEXT_SIBLING]: next("nextSibling"),
    [APPLY_TRANSITION]: (v) => {
      if (options.transition && document.startViewTransition) {
        // @ts-ignore
        window.lastDiffTransition = document.startViewTransition(v);
      } else v();
    },
  };
}
