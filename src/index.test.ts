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
    it("should not call document.startViewTransition for each DOM update with transition=false", async () => {
      browser = await engine.chrome.launch();
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
      browser = await engine.chrome.launch();
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
      expect(newHTML).toBe(
        normalize(`
        <html>
          <head></head>
          <body>
              <div>bar</div>
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
  });

  async function testDiff({
    oldHTMLString,
    newHTMLStringChunks,
    useForEeachStreamNode = false,
    slowChunks = false,
    transition = false,
    ignoreId = false,
    registerWC = false,
    onNextNode,
  }: {
    oldHTMLString: string;
    newHTMLStringChunks: string[];
    useForEeachStreamNode?: boolean;
    slowChunks?: boolean;
    transition?: boolean;
    ignoreId?: boolean;
    registerWC?: boolean;
    onNextNode?: string
  }): Promise<[string, any[], Node[], boolean, string]> {
    await page.setContent(normalize(oldHTMLString));
    const [mutations, streamNodes, transitionApplied, logs] = await page.evaluate(
      async ([
        diffCode,
        newHTMLStringChunks,
        useForEeachStreamNode,
        slowChunks,
        transition,
        ignoreId,
        registerWC,
        onNextNode,
      ]) => {
        eval(diffCode as string);
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start: async (controller) => {
            for (const chunk of newHTMLStringChunks as string[]) {
              if (slowChunks)
                await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
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
        });

        // @ts-ignore
        const transitionApplied = !!window.lastDiffTransition;

        observer.disconnect();

        return [allMutations, streamNodes, transitionApplied, (window as any).logs];
      },
      [
        diffCode,
        newHTMLStringChunks,
        useForEeachStreamNode,
        slowChunks,
        transition,
        ignoreId,
        registerWC,
        onNextNode,
      ],
    );

    return [
      (await page.content()).replace(/\s*\n\s*/g, "").replaceAll("'", '"'),
      mutations,
      streamNodes,
      transitionApplied,
      logs
    ];
  }
});
