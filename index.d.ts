export default function diff(
  oldNode: Node,
  stream: ReadableStream,
  options?: Options,
): Promise<void>;

type NextNodeCallback = (node: Node) => void;

type Options = {
  onNextNode?: NextNodeCallback;
  transition?: boolean;
  shouldIgnoreNode?: (node: Node | null) => boolean;
  /**
   * The node's children belong to another renderer (a live embedded React
   * root): the diff updates the node itself — attributes sync as usual — but
   * never walks into its subtree. Called with nodes from BOTH the live and
   * the incoming tree, so the answer must come from the node itself (tag
   * name, attributes), not from external identity.
   */
  shouldSkipChildren?: (node: Node | null) => boolean;
};
