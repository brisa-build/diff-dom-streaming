import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
} from "bun:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import diff from "./index";
import { join } from "node:path";

const engine: Record<string, any> = {
  chrome: chromium,
  firefox: firefox,
  safari: webkit,
};

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const diffCode = await transpiler.transform(
  (await Bun.file(join(import.meta.dir, "index.ts")).text()).replace(
    "export default",
    "",
  ),
);
const normalize = (t: string) =>
  t.replace(/\s*\n\s*/g, "").replaceAll("'", '"');

describe("Diff test", () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await browser.close();
  });

  describe("Chrome View Transitions API", () => {
    beforeAll(async () => {
      browser = await engine.chrome.launch();
    });

    it("should not call document.startViewTransition for each DOM update with transition=false", async () => {
      const [newHTML, , , transitionApplied] = await testDiff({
        oldHTMLString: `
        <div>
          <h1>hello world</h1>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<h1>hello world!</h1>", "</div>"],
        transition: false,
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <h1>hello world!</h1>
          </div>
        </body>
      </html>
    `),
      );
      expect(transitionApplied).toBeFalse();
    });
    it("should call document.startViewTransition for each DOM update with transition=true", async () => {
      const [newHTML, , , transitionApplied] = await testDiff({
        oldHTMLString: `
        <div>
          <h1>hello world</h1>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<h1>hello world!</h1>", "</div>"],
        transition: true,
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <h1>hello world!</h1>
          </div>
        </body>
      </html>
    `),
      );
      expect(transitionApplied).toBeTrue();
    });

    /**
     * A router wrapping the whole swap in one transition, rather than letting
     * `transition: true` start one per DOM update — the only way shared
     * `view-transition-name` elements are paired across a full page change.
     *
     * A view transition suppresses rendering until its update callback
     * resolves, so `requestAnimationFrame` never fires inside one. Settling the
     * stream on rAF alone therefore deadlocks the walk until the browser aborts
     * the transition on its 4s DOM-update timeout: the page freezes for four
     * seconds and then swaps with no animation at all.
     */
    it("should complete a diff that runs inside document.startViewTransition", async () => {
      await page.setContent(normalize(`<div><h1>hello world</h1></div>`));

      const result = await page.evaluate(async (code) => {
        eval(code as string);
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            for (const chunk of ["<div>", "<h1>hello world!</h1>", "</div>"]) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });
        const startedAt = performance.now();
        // @ts-ignore
        const transition = document.startViewTransition(() =>
          // @ts-ignore
          diff(document.documentElement!, readable),
        );

        transition.finished.catch(() => {});
        await transition.updateCallbackDone;

        return {
          elapsed: performance.now() - startedAt,
          ready: await transition.ready.then(
            () => "resolved",
            (error: any) => `rejected: ${error?.name}`,
          ),
          heading: document.querySelector("h1")?.textContent,
        };
      }, diffCode);

      expect(result.heading).toBe("hello world!");
      // Not aborted: a timed-out transition applies the DOM change but never animates.
      expect(result.ready).toBe("resolved");
      // The deadlock ended at Chrome's 4s cap; a working swap is milliseconds.
      expect(result.elapsed).toBeLessThan(2000);
    });
  });

  describe.each(["chrome", "firefox", "safari"])("%s", (browserName) => {
    beforeAll(async () => {
      browser = await engine[browserName].launch();
    });

    it("should error with invalid arguments", async () => {
      const res = new Response('<div id="test">hello world</div>');
      expect(() => diff("hello world" as any, res.body!)).toThrow(Error);
    });

    it("should not do any DOM modification", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <h1>hello world</h1>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<h1>hello world</h1>", "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <h1>hello world</h1>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toBeEmpty();
    });

    it("should replace only the body content", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body>
            <div>hello world</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: ["something else"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          something else
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [
            {
              nodeName: "#text",
              nodeValue: "something else",
              keepsExistingNodeReference: false,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML: "<body>something else</body>",
          removedNodes: [
            {
              nodeName: "DIV",
              nodeValue: null,
            },
          ],
          tagName: "BODY",
          type: "childList",
        },
      ]);
    });

    it("should update only one element of the body", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body>
            <h1>TEST</h1>
            <div id="test">Old Node Content</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<h1>TEST</h1>",
          '<div id="test">',
          "New Node Content",
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <h1>TEST</h1>
          <div id="test">New Node Content</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "Old Node Content",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
      ]);
    });

    it("should diff attributes", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `<div></div>`,
        newHTMLStringChunks: ['<div a="1" b="2">', "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div b="2" a="1"></div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: "b",
          oldValue: null,
          outerHTML: '<div b="2" a="1"></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: "a",
          oldValue: null,
          outerHTML: '<div b="2" a="1"></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "attributes",
        },
      ]);
    });

    it("should diff nodeValue", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          text a
          text b
        </div>
      `,
        newHTMLStringChunks: ["<div>", "text a", "text c", "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            text a
            text c
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "text atext b",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
      ]);
    });

    it("should diff children", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <b>text</b>
          <i>text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<a href="link2">hello2</a>',
          "<i>text1</i>",
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link2">hello2</a>
            <i>text1</i>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "hello",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "href",
          oldValue: "link",
          outerHTML: '<a href="link2">hello2</a>',
          removedNodes: [],
          tagName: "A",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "text",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: "<b></b>",
          removedNodes: [
            {
              nodeName: "#text",
              nodeValue: "text1",
            },
          ],
          tagName: "B",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
              keepsExistingNodeReference: false,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><i>text1</i><i>text2</i></div>',
          removedNodes: [
            {
              nodeName: "B",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: '<div><a href="link2">hello2</a><i>text1</i></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (id)", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <b>text</b>
          <i id="test">text2</i>
        </div>
      `,
        newHTMLStringChunks: ["<div>", '<i id="test">text1</i>', "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <i id="test">text1</i>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: `<div><i id="test">text2</i><b>text</b></div>`,
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
              keepsExistingNodeReference: true,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML: `<div><i id="test">text2</i><b>text</b></div>`,
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "text2",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: `<div><i id="test">text1</i></div>`,
          removedNodes: [
            {
              nodeName: "B",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) move by deleting", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <b>text</b>
          <i key="test">text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<a href="link2">hello2</a>',
          '<i key="test">text1</i>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link2">hello2</a>
            <i key="test">text1</i>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "hello",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "href",
          oldValue: "link",
          outerHTML: '<a href="link2">hello2</a>',
          removedNodes: [],
          tagName: "A",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><i key="test">text2</i><b>text</b></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
              keepsExistingNodeReference: true,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><i key="test">text2</i><b>text</b></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "text2",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><i key="test">text1</i></div>',
          removedNodes: [
            {
              nodeName: "B",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) move by shuffling", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <b key="test1">text</b>
          <i key="test2">text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<a href="link">hello</a>',
          '<i key="test2">text2</i>',
          '<b key="test1">text</b>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link">hello</a>
            <i key="test2">text2</i>
            <b key="test1">text</b>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link">hello</a><i key="test2">text2</i><b key="test1">text</b></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
              keepsExistingNodeReference: true,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link">hello</a><i key="test2">text2</i><b key="test1">text</b></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) remove", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <b>text</b>
          <i key="test">text2</i>
        </div>
      `,
        newHTMLStringChunks: ["<div>", '<a href="link2">hello2</a>', "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link2">hello2</a>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "hello",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "href",
          oldValue: "link",
          outerHTML: '<a href="link2">hello2</a>',
          removedNodes: [],
          tagName: "A",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: '<div><a href="link2">hello2</a></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: '<div><a href="link2">hello2</a></div>',
          removedNodes: [
            {
              nodeName: "B",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) insert new node", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <i key="test">text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<a href="link2">hello2</a>',
          "<b>test</b>",
          '<i key="test">text2</i>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link2">hello2</a>
            <b>test</b>
            <i key="test">text2</i>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "hello",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "href",
          oldValue: "link",
          outerHTML: '<a href="link2">hello2</a>',
          removedNodes: [],
          tagName: "A",
          type: "attributes",
        },
        {
          addedNodes: [
            {
              keepsExistingNodeReference: false,
              nodeName: "B",
              nodeValue: null,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><b>test</b><i key="test">text2</i></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><b>test</b><i key="test">text2</i></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              keepsExistingNodeReference: true,
              nodeName: "I",
              nodeValue: null,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link2">hello2</a><b>test</b><i key="test">text2</i></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) with xhtml namespaceURI", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div xmlns="http://www.w3.org/1999/xhtml">
          <a href="link">hello</a>
          <b>text</b>
          <i key="test">text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          '<div xmlns="http://www.w3.org/1999/xhtml">',
          '<a href="link2">hello2</a>',
          '<i key="test">text1</i>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div xmlns="http://www.w3.org/1999/xhtml">
            <a href="link2">hello2</a>
            <i key="test">text1</i>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "hello",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "href",
          oldValue: "link",
          outerHTML: '<a href="link2">hello2</a>',
          removedNodes: [],
          tagName: "A",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div xmlns="http://www.w3.org/1999/xhtml"><a href="link2">hello2</a><i key="test">text2</i><b>text</b></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              keepsExistingNodeReference: true,
              nodeName: "I",
              nodeValue: null,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div xmlns="http://www.w3.org/1999/xhtml"><a href="link2">hello2</a><i key="test">text2</i><b>text</b></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "text2",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div xmlns="http://www.w3.org/1999/xhtml"><a href="link2">hello2</a><i key="test">text1</i></div>',
          removedNodes: [
            {
              nodeName: "B",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should diff children (key) move (custom attribute)", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <a href="link">hello</a>
          <b key="test1">text</b>
          <i key="test2">text2</i>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<a href="link">hello</a>',
          '<i key="test2">text2</i>',
          '<b key="test1">text</b>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <a href="link">hello</a>
            <i key="test2">text2</i>
            <b key="test1">text</b>
          </div>
        </body>
      </html>
    `),
      );

      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link">hello</a><i key="test2">text2</i><b key="test1">text</b></div>',
          removedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "I",
              nodeValue: null,
              keepsExistingNodeReference: true,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<div><a href="link">hello</a><i key="test2">text2</i><b key="test1">text</b></div>',
          removedNodes: [],
          tagName: "DIV",
          type: "childList",
        },
      ]);
    });

    it("should only replace the lang attribute of the HTML tag", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html lang="en">
          <head></head>
          <body>
            <div>hello world</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          '<html lang="es">',
          "<head></head>",
          "<body>",
          "<div>hello world</div>",
          "</body>",
          "</html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html lang="es">
        <head></head>
        <body>
          <div>hello world</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: "lang",
          oldValue: "en",
          outerHTML:
            '<html lang="es"><head></head><body><div>hello world</div></body></html>',
          removedNodes: [],
          tagName: "HTML",
          type: "attributes",
        },
      ]);
    });

    it("should only update the title content inside head", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html>
          <head>
            <title>Old Title</title>
          </head>
          <body>
            <div>hello world</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head>",
          "<title>New Title</title>",
          "</head>",
          "<body>",
          "<div>hello world</div>",
          "</body>",
          "</html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head>
          <title>New Title</title>
        </head>
        <body>
          <div>hello world</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "Old Title",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
      ]);
    });

    it("should change data-attribute", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div data-attribute="abc">foo</div>
      `,
        newHTMLStringChunks: ['<div data-attribute="efg">', "foo", "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div data-attribute="efg">foo</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: "data-attribute",
          oldValue: "abc",
          outerHTML: '<div data-attribute="efg">foo</div>',
          removedNodes: [],
          tagName: "DIV",
          type: "attributes",
        },
      ]);
    });

    it("should update only the path of an SVG element", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <svg>
          <path d="M 10 10 L 20 20"></path>
        </svg>
      `,
        newHTMLStringChunks: [
          "<svg>",
          '<path d="M 20 20 L 30 30"></path>',
          "</svg>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <svg>
            <path d="M 20 20 L 30 30"></path>
          </svg>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: "d",
          oldValue: "M 10 10 L 20 20",
          outerHTML: '<path d="M 20 20 L 30 30"></path>',
          removedNodes: [],
          tagName: "path",
          type: "attributes",
        },
      ]);
    });

    it("should diff children (data-checksum)", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <div class="a" data-checksum="abc">initial</div>
        </div>
      `,
        newHTMLStringChunks: [
          "<div>",
          '<div class="b" data-checksum="efg">final</div>',
          "</div>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <div class="b" data-checksum="efg">final</div>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "initial",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: "data-checksum",
          oldValue: "abc",
          outerHTML: '<div class="b" data-checksum="efg">final</div>',
          removedNodes: [],
          tagName: "DIV",
          type: "attributes",
        },
        {
          addedNodes: [],
          attributeName: "class",
          oldValue: "a",
          outerHTML: '<div class="b" data-checksum="efg">final</div>',
          removedNodes: [],
          tagName: "DIV",
          type: "attributes",
        },
      ]);
    });

    it("should diff between an entire document and documentElement", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <!DOCTYPE html>
        <html>
          <head></head>
          <body>hello foo</body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head></head>",
          "<body>hello bar</body>",
          "</html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
        <!DOCTYPE html>
        <html>
          <head></head>
          <body>
            hello bar
          </body>
        </html>
      `),
      );
      expect(mutations).toEqual([
        {
          type: "characterData",
          addedNodes: [],
          removedNodes: [],
          attributeName: null,
          tagName: undefined,
          outerHTML: undefined,
          oldValue: "hello foo",
        },
      ]);
    });

    it("should diff between entire documents", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <!DOCTYPE html>
        <html>
          <head></head>
          <body>hello foo</body>
        </html>
      `,
        newHTMLStringChunks: [
          "<!DOCTYPE html>",
          "<html>",
          "<head></head>",
          "<body>hello bar</body>",
          "</html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
        <!DOCTYPE html>
        <html>
          <head></head>
          <body>
            hello bar
          </body>
        </html>
      `),
      );
      expect(mutations).toEqual([
        {
          type: "characterData",
          addedNodes: [],
          removedNodes: [],
          attributeName: null,
          tagName: undefined,
          outerHTML: undefined,
          oldValue: "hello foo",
        },
      ]);
    });

    it("should don't modify if is the same node with diffent way to close the tag", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <div></div>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<div />", "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <div></div>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([]);
    });

    it("should diff and patch html strings with special chars", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>
          <div>hello world</div>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<div>hello & world</div>", "</div>"],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>
            <div>hello &amp; world</div>
          </div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          type: "characterData",
          addedNodes: [],
          removedNodes: [],
          attributeName: null,
          tagName: undefined,
          outerHTML: undefined,
          oldValue: "hello world",
        },
      ]);
    });

    it("should analyze all stream nodes using a forEachStreamNode", async () => {
      const [, , streamNodes] = await testDiff({
        oldHTMLString: `
        <div>
          <div>hello world</div>
        </div>
      `,
        newHTMLStringChunks: ["<div>", "<div>hello & world</div>", "</div>"],
        useForEeachStreamNode: true,
      });

      // Analyze all stream nodes via forEachStreamNode
      expect(streamNodes).toHaveLength(5);
      expect(streamNodes[0].nodeName).toBe("HEAD");
      expect(streamNodes[1].nodeName).toBe("BODY");
      expect(streamNodes[2].nodeName).toBe("DIV");
      expect(streamNodes[3].nodeName).toBe("DIV");
      expect(streamNodes[4].nodeName).toBe("#text");
      expect(streamNodes[4].nodeValue).toBe("hello & world");
    });

    it("should diff with slow chunks", async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body>
            <div>foo</div>
            <div>bar</div>
            <div>baz</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head></head>",
          "<body>",
          "<div>baz</div>",
          "<div>foo</div>",
          "<div>bar</div>",
          "</body>",
          "</html>",
        ],
        slowChunks: true,
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>baz</div>
          <div>foo</div>
          <div>bar</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "foo",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "bar",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
        {
          addedNodes: [],
          attributeName: null,
          oldValue: "baz",
          outerHTML: undefined,
          removedNodes: [],
          tagName: undefined,
          type: "characterData",
        },
      ]);
    });

    it('should replace a div to "template" tag with the content', async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body>
            <div>foo</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head></head>",
          "<body>",
          '<template id="U:1"><div>bar</div></template>',
          "</body>",
          "</html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <template id="U:1">
            <div>bar</div>
          </template>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([
        {
          addedNodes: [],
          attributeName: null,
          oldValue: null,
          outerHTML: "<div></div>",
          removedNodes: [
            {
              nodeName: "#text",
              nodeValue: "foo",
            },
          ],
          tagName: "DIV",
          type: "childList",
        },
        {
          addedNodes: [
            {
              nodeName: "TEMPLATE",
              nodeValue: null,
              keepsExistingNodeReference: false,
            },
          ],
          attributeName: null,
          oldValue: null,
          outerHTML:
            '<body><template id="U:1"><div>bar</div></template></body>',
          removedNodes: [
            {
              nodeName: "DIV",
              nodeValue: null,
            },
          ],
          tagName: "BODY",
          type: "childList",
        },
      ]);
    });

    it("should diff with body without div wrapper and with div wrapper", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body>
            <script id="foo">(()=>{})();</script>
            <div class="flex flex-col items-center justify-center px-6 py-16">
              This will be a landingpage. But you can go to the admin for now <a href="/en/admin">login page</a>
            </div>
            <error-dialog skipssr=""></error-dialog>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head></head>",
          "<body>",
          "<div>",
          "<script id='foo'>(()=>{})();</script>",
          "<div class='flex flex-col items-center justify-center px-6 py-16'>",
          "This will be a Admin Page. But you can go to the admin for now <a href='/en'>home page</a>",
          "</div>",
          "</div>",
          '<error-dialog skipssr=""></error-dialog>',
          "</body>",
          "</html>",
        ],
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div>
              <script id="foo">(()=>{})();</script>
              <div class="flex flex-col items-center justify-center px-6 py-16">
                This will be a Admin Page. But you can go to the admin for now <a href="/en">home page</a>
              </div>
            </div>
            <error-dialog skipssr=""></error-dialog>
          </body>
        </html>`),
      );
    });

    it('should not add again the "data-action" attribute after diff to avoid registering server actions twice', async () => {
      const [newHTML, mutations] = await testDiff({
        oldHTMLString: `
        <div>foo</div>
      `,
        newHTMLStringChunks: ['<div data-action="foo">foo</div>'],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body>
          <div>foo</div>
        </body>
      </html>
    `),
      );
      expect(mutations).toEqual([]);
    });

    it("should change the content of the BODY but keep the old attributes (theme, etc)", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <html>
          <head></head>
          <body data-theme="dark">
            <div>foo</div>
          </body>
        </html>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div>bar</div></body></html>",
        ],
      });
      expect(newHTML).toBe(
        normalize(`
      <html>
        <head></head>
        <body data-theme="dark">
          <div>bar</div>
        </body>
      </html>
    `),
      );
    });

    it("should options.shouldIgnoreNode work", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <div>foo</div>
          <div id="ignore">bar</div>
        </div>
      `,
        newHTMLStringChunks: [
          "<html>",
          "<head></head>",
          "<body>",
          "<div>bar</div>",
          "<div id='ignore'>bazz!</div>",
          "</body>",
          "</html>",
        ],
        ignoreId: true,
      });
      // Ignored means untouched: the node keeps its own content ("bar", not the
      // incoming "bazz!") and stays put, while its siblings diff as usual.
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
              <div>bar<div id="ignore">bar</div></div>
          </body>
        </html>
    `),
      );
    });

    it("should options.shouldIgnoreNode skip an ignored node followed by a sibling", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <span id="ignore">skip</span>
          <b>old</b>
        </div>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div><span id='ignore'>skip</span><b>new</b></div></body></html>",
        ],
        ignoreId: true,
      });
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div><span id="ignore">skip</span><b>new</b></div>
          </body>
        </html>
    `),
      );
    });

    it("should options.shouldIgnoreNode keep an ignored node the incoming page does not list", async () => {
      // The reason the option exists: a stylesheet injected at runtime (a lazy
      // editor's CSS, a dev server's <style>) lives only in the live document,
      // so the incoming page is always one node shorter. Counting it made the
      // tail removal take it, and re-attaching a detached stylesheet leaves it
      // pending — the page paints unstyled for a frame.
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <b>old</b>
          <span id="ignore">injected</span>
        </div>
      `,
        newHTMLStringChunks: ["<html><head></head><body><div><b>new</b></div></body></html>"],
        ignoreId: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div><b>new</b><span id="ignore">injected</span></div>
          </body>
        </html>
    `),
      );
    });

    it("should options.shouldSkipChildren keep the old subtree while syncing the node's attributes", async () => {
      // What an embedded framework root (a live React island) needs: the diff
      // must not rewrite DOM another renderer owns — its fibers keep node
      // references and later reconciliations bail out against text the morph
      // changed behind their back, or throw removeChild on nodes it moved.
      // The host element itself still belongs to the page (attributes sync);
      // only its children are out of the diff's scope.
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <section data-skip-children="x" data-v="1"><span>client</span></section>
          <p>old</p>
        </div>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div><section data-skip-children='x' data-v='2'><span>server</span></section><p>new</p></div></body></html>",
        ],
        skipChildren: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div><section data-skip-children="x" data-v="2"><span>client</span></section><p>new</p></div>
          </body>
        </html>
    `),
      );
    });

    it("should options.shouldSkipChildren hold across chunk boundaries inside the skipped subtree", async () => {
      // The skipped subtree may still be streaming when the walk reaches it:
      // its children must neither be awaited (the walk moves on) nor applied
      // once they arrive — including the settled reconciliation pass, which
      // must not count them as unvisited work.
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <section data-skip-children="x"><span>client</span></section>
          <p>old</p>
        </div>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div><section data-skip-children='x'><span>ser",
          "ver</span><i>extra</i></section><p>new</p></div></body></html>",
        ],
        skipChildren: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div><section data-skip-children="x"><span>client</span></section><p>new</p></div>
          </body>
        </html>
    `),
      );
    });

    it("should options.shouldSkipChildren never donate the old children to a different replacing element", async () => {
      // Positional match against a DIFFERENT tag replaces the node, and the
      // replacement normally inherits the old (already-diffed) children. A
      // skipped node's children were never diffed and still belong to their
      // renderer: moving them re-parents DOM its internal tree references
      // (unmount then throws removeChild), so the incoming subtree applies
      // wholesale and the old children leave the document with their node.
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <section data-skip-children="x"><span>client</span></section>
        </div>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div><article><b>fresh</b></article></div></body></html>",
        ],
        skipChildren: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div><article><b>fresh</b></article></div>
          </body>
        </html>
    `),
      );
    });

    it("should apply nodes the parser moves before the walk frontier (table foster parenting across chunks)", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>
          <table><tbody><tr><td>x</td></tr></tbody></table>
        </div>
      `,
        newHTMLStringChunks: [
          "<html><head></head><body><div><table><tbody><tr><td>y</td></tr>",
          "oops</tbody></table></div></body></html>",
        ],
        slowChunks: true,
      });
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div>oops<table><tbody><tr><td>y</td></tr></tbody></table></div>
          </body>
        </html>
    `),
      );
    });

    it("should add WC that modifies the DOM on connect it", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>foo</div>
      `,
        newHTMLStringChunks: ["<test-wc>foo</test-wc>"],
        registerWC: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <test-wc data-connected="true">foo</test-wc>
          </body>
        </html>
      `),
      );
    });

    it("should onNextNode execute in a sequential way when is async", async () => {
      const results = await testDiff({
        oldHTMLString: `
        <div>foo</div>
      `,
        newHTMLStringChunks: ["<div scan>first</div>", "<div scan>second</div>", "<div scan>third</div>"],
        registerWC: true,
        onNextNode: `async (n) => {
          if (!n?.hasAttribute?.('scan')) return
          window.index ??= 1;
          window.logs ??= '';
          await new Promise((r) => setTimeout(() => {
            window.logs += n.innerText + ' ';
            r(true);
          }, ++window.index * 50));
        }`
      });

      expect(results[0]).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div scan="">first</div>
            <div scan="">second</div>
            <div scan="">third</div>
          </body>
        </html>
      `),
      );

      expect(results.at(-1)).toBe('first second third ')
    });

    it("should add WC that modifies the DOM on connect it (old with key)", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div key="old">foo</div>
      `,
        newHTMLStringChunks: ["<test-wc>foo</test-wc>"],
        registerWC: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <test-wc data-connected="true">foo</test-wc>
          </body>
        </html>
      `),
      );
    });

    it("should diff correctly when tag and attribute names are split across chunks", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div class="x">adios</div>
      `,
        newHTMLStringChunks: ["<di", "v cla", 'ss="a">hola</d', "iv>"],
        slowChunks: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div class="a">hola</div>
          </body>
        </html>
      `),
      );
    });

    it("should diff correctly when an attribute value is split across chunks", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div class="x">x</div>
      `,
        newHTMLStringChunks: ['<div class="a', 'b">x</div>'],
        slowChunks: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div class="ab">x</div>
          </body>
        </html>
      `),
      );
    });

    it("should decode multi-byte UTF-8 characters split across chunk boundaries", async () => {
      const encoded = Array.from(
        new TextEncoder().encode("<div>mañana 🚀</div>"),
      );

      // "ñ" is 2 bytes starting at index 7 → cutting at 8 splits it in half.
      // "🚀" is 4 bytes starting at index 13 → cutting at 16 splits it apart.
      expect(encoded.slice(7, 9)).toEqual([0xc3, 0xb1]);
      expect(encoded.slice(13, 17)).toEqual([0xf0, 0x9f, 0x9a, 0x80]);

      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>old</div>
      `,
        newHTMLByteChunks: [
          encoded.slice(0, 8),
          encoded.slice(8, 16),
          encoded.slice(16),
        ],
        slowChunks: true,
      });

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div>mañana 🚀</div>
          </body>
        </html>
      `),
      );
    });

    // Pins the CURRENT behavior: new <script> elements are parsed inside an
    // inert document (createHTMLDocument + doc.write), which marks them as
    // "already started"; cloneNode copies that flag, so inserting the clone
    // into the live document does NOT execute it.
    it("should insert a NEW streamed inline <script> without executing it (pins current behavior)", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `
        <div>foo</div>
      `,
        newHTMLStringChunks: [
          "<div>foo</div>",
          "<script>window.__executed = true</script>",
        ],
      });
      const executed = await page.evaluate(
        () => (window as any).__executed === true,
      );

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div>foo</div>
            <script>window.__executed = true</script>
          </body>
        </html>
      `),
      );
      expect(executed).toBeFalse();
    });

    it("should NOT re-execute a pre-existing <script> with the same content", async () => {
      const [newHTML] = await testDiff({
        oldHTMLString: `<script>window.__count = (window.__count || 0) + 1</script><div>foo</div>`,
        newHTMLStringChunks: [
          "<script>window.__count = (window.__count || 0) + 1</script>",
          "<div>bar</div>",
        ],
      });
      const count = await page.evaluate(() => (window as any).__count);

      expect(newHTML).toBe(
        normalize(`
        <html>
          <head>
            <script>window.__count = (window.__count || 0) + 1</script>
          </head>
          <body>
            <div>bar</div>
          </body>
        </html>
      `),
      );
      // Executed exactly once (on initial page load), not again after diffing.
      expect(count).toBe(1);
    });

    it("should reject the diff when the stream errors after a chunk instead of hanging the walker", async () => {
      await expect(
        testDiff({
          oldHTMLString: `
        <div>foo</div>
      `,
          newHTMLStringChunks: ["<div>bar</div>"],
          errorStreamMessage: "network dead",
          slowChunks: true,
        }),
      ).rejects.toThrow("network dead");
    });

    it("should reject the diff when the stream errors before any chunk", async () => {
      await expect(
        testDiff({
          oldHTMLString: `
        <div>foo</div>
      `,
          newHTMLStringChunks: [],
          errorStreamMessage: "network dead",
        }),
      ).rejects.toThrow("network dead");
    });

    it("should apply children of an open last node progressively (main as last child)", async () => {
      const [newHTML, , , , midStreamH1] = await testDiff({
        oldHTMLString: `
        <div class="layout">
          <nav><a>nav</a></nav>
          <main><article><h1>OLD</h1><p>para OLD</p><p>tail</p></article></main>
        </div>
      `,
        newHTMLStringChunks: [
          '<div class="layout"><nav><a>nav</a></nav><main><article><h1>NEW</h1><p>para NEW</p>',
          "<p>tail</p></article></main></div>",
        ],
        midStreamEval: `document.querySelector('h1').textContent`,
      });

      // The <main> subtree must be diffed WHILE the stream is still open,
      // even though <main> is the last child of a still-open container.
      expect(midStreamH1).toBe("NEW");
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div class="layout">
              <nav><a>nav</a></nav>
              <main><article><h1>NEW</h1><p>para NEW</p><p>tail</p></article></main>
            </div>
          </body>
        </html>
      `),
      );
    });

    it("should apply an open last node progressively and still ADD trailing siblings from a later chunk", async () => {
      const [newHTML, , , , midStreamH1] = await testDiff({
        oldHTMLString: `
        <div class="layout">
          <nav><a>nav</a></nav>
          <main><article><h1>OLD</h1><p>tail</p></article></main>
        </div>
      `,
        newHTMLStringChunks: [
          '<div class="layout"><nav><a>nav</a></nav><main><article><h1>NEW</h1><p>tail</p>',
          "</article></main><footer>bye</footer></div>",
        ],
        midStreamEval: `document.querySelector('h1').textContent`,
      });

      expect(midStreamH1).toBe("NEW");
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div class="layout">
              <nav><a>nav</a></nav>
              <main><article><h1>NEW</h1><p>tail</p></article></main>
              <footer>bye</footer>
            </div>
          </body>
        </html>
      `),
      );
    });

    it("should defer pruning of trailing old nodes until the open level is closed", async () => {
      const [newHTML, , , , midStream] = await testDiff({
        oldHTMLString: `
        <div class="layout">
          <nav><a>nav</a></nav>
          <main><article><h1>OLD</h1><p>tail</p></article></main>
          <footer>bye</footer>
          <aside>ads</aside>
        </div>
      `,
        newHTMLStringChunks: [
          '<div class="layout"><nav><a>nav</a></nav><main><article><h1>NEW</h1><p>tail</p>',
          "</article></main></div>",
        ],
        midStreamEval: `JSON.stringify({
          h1: document.querySelector('h1').textContent,
          footer: !!document.querySelector('footer'),
          aside: !!document.querySelector('aside'),
        })`,
      });

      // Mid-stream: the open subtree is already applied, but the trailing old
      // nodes are NOT pruned yet — the level may still receive new children.
      expect(JSON.parse(midStream)).toEqual({
        h1: "NEW",
        footer: true,
        aside: true,
      });
      // Once the stream closes, the deferred pruning runs.
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
            <div class="layout">
              <nav><a>nav</a></nav>
              <main><article><h1>NEW</h1><p>tail</p></article></main>
            </div>
          </body>
        </html>
      `),
      );
    });
  });

  async function testDiff({
    oldHTMLString,
    newHTMLStringChunks = [],
    newHTMLByteChunks,
    errorStreamMessage,
    midStreamEval,
    useForEeachStreamNode = false,
    slowChunks = false,
    transition = false,
    ignoreId = false,
    skipChildren = false,
    registerWC = false,
    onNextNode,
  }: {
    oldHTMLString: string;
    newHTMLStringChunks?: string[];
    // Raw byte chunks (each an array of UTF-8 byte values) to test chunk
    // boundaries that split multi-byte characters, which cannot be expressed
    // as JS strings.
    newHTMLByteChunks?: number[][];
    // When set, the stream errors with this message after emitting all chunks
    // instead of closing (simulates an aborted fetch / dead network).
    errorStreamMessage?: string;
    // JS expression evaluated in the page BEFORE enqueuing the last chunk
    // (after a settle delay), to observe the mid-stream DOM state.
    midStreamEval?: string;
    useForEeachStreamNode?: boolean;
    slowChunks?: boolean;
    transition?: boolean;
    ignoreId?: boolean;
    skipChildren?: boolean;
    registerWC?: boolean;
    onNextNode?: string
  }): Promise<[string, any[], Node[], boolean, any, string]> {
    await page.setContent(normalize(oldHTMLString));
    const [mutations, streamNodes, transitionApplied, midStreamResult, logs] = await page.evaluate(
      async ([
        diffCode,
        newHTMLStringChunks,
        newHTMLByteChunks,
        errorStreamMessage,
        midStreamEval,
        useForEeachStreamNode,
        slowChunks,
        transition,
        ignoreId,
        skipChildren,
        registerWC,
        onNextNode,
      ]) => {
        eval(diffCode as string);
        const encoder = new TextEncoder();
        const byteChunks = newHTMLByteChunks as number[][] | undefined;
        const chunks = byteChunks ?? (newHTMLStringChunks as string[]);
        let midStreamResult;
        const readable = new ReadableStream({
          start: async (controller) => {
            for (let i = 0; i < chunks.length; i++) {
              if (slowChunks)
                await new Promise((resolve) => setTimeout(resolve, 100));
              if (midStreamEval && i === chunks.length - 1) {
                // Let the walker settle on the already-emitted chunks before
                // observing the mid-stream DOM state.
                await new Promise((resolve) => setTimeout(resolve, 500));
                midStreamResult = eval(midStreamEval as string);
              }
              const chunk = chunks[i];
              controller.enqueue(
                byteChunks
                  ? new Uint8Array(chunk as number[])
                  : encoder.encode(chunk as string),
              );
            }
            if (errorStreamMessage) {
              // Let the already-enqueued chunks be consumed by the walker
              // first, so the error lands while it awaits the next chunk.
              if (slowChunks)
                await new Promise((resolve) => setTimeout(resolve, 100));
              controller.error(new Error(errorStreamMessage as string));
            } else {
              controller.close();
            }
          },
        });
        const allMutations: any[] = [];
        const observer = new MutationObserver((mutations) => {
          allMutations.push(
            ...mutations.map((mutation, mutationIndex) => ({
              type: mutation.type,
              addedNodes: Array.from(mutation.addedNodes).map(
                (node, index) => ({
                  nodeName: node.nodeName,
                  nodeValue: node.nodeValue,
                  keepsExistingNodeReference: node.isSameNode(
                    mutations[mutationIndex - 1]?.removedNodes?.[index],
                  ),
                }),
              ),
              removedNodes: Array.from(mutation.removedNodes).map(
                (node) => ({
                  nodeName: node.nodeName,
                  nodeValue: node.nodeValue,
                }),
              ),
              attributeName: mutation.attributeName,
              tagName: (mutation.target as Element).tagName,
              outerHTML: (mutation.target as Element).outerHTML,
              oldValue: mutation.oldValue,
            })),
          );
        });

        observer.observe(document.documentElement, {
          childList: true,
          attributes: true,
          subtree: true,
          attributeOldValue: true,
          characterData: true,
          characterDataOldValue: true,
        });

        const streamNodes: Node[] = [];

        const forEachStreamNode = useForEeachStreamNode
          ? (node: Node) => {
              streamNodes.push({
                nodeName: node.nodeName,
                nodeValue: node.nodeValue,
              } as Node);
            }
          : eval(onNextNode);

        if (registerWC) {
          class TestWC extends HTMLElement {
            connectedCallback() {
              this.setAttribute("data-connected", "true");
            }
          }
          customElements.define("test-wc", TestWC);
        }

        await diff(document.documentElement!, readable, {
          onNextNode: forEachStreamNode,
          transition: transition as boolean,
          shouldIgnoreNode(node: Node | null) {
            if (!ignoreId) return false;
            return (node as Element)?.id === "ignore";
          },
          shouldSkipChildren(node: Node) {
            if (!skipChildren) return false;
            return !!(node as Element)?.hasAttribute?.("data-skip-children");
          },
        });

        // @ts-ignore
        const transitionApplied = !!window.lastDiffTransition;

        observer.disconnect();

        return [allMutations, streamNodes, transitionApplied, midStreamResult, (window as any).logs];
      },
      [
        diffCode,
        newHTMLStringChunks,
        newHTMLByteChunks,
        errorStreamMessage,
        midStreamEval,
        useForEeachStreamNode,
        slowChunks,
        transition,
        ignoreId,
        skipChildren,
        registerWC,
        onNextNode,
      ],
    );

    return [
      (await page.content()).replace(/\s*\n\s*/g, "").replaceAll("'", '"'),
      mutations,
      streamNodes,
      transitionApplied,
      midStreamResult,
      logs
    ];
  }
});
