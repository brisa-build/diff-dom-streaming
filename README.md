<p align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/aralroca/diff-dom-streaming/assets/13313058/ca678952-6232-4db4-aff2-c4bedade4f9a" width="128">
      <img src="https://github.com/aralroca/diff-dom-streaming/assets/13313058/6d544ef2-651e-4907-a246-abc6c859ab5c" width="128">
    </picture>
        <h1 align="center">Diff DOM Streaming</h1>
</p>

[![npm version](https://badge.fury.io/js/diff-dom-streaming.svg)](https://badge.fury.io/js/diff-dom-streaming)
![npm](https://img.shields.io/npm/dw/diff-dom-streaming)
![size](https://img.shields.io/bundlephobia/minzip/diff-dom-streaming)
[![PRs Welcome][badge-prwelcome]][prwelcome]
<a href="https://github.com/aralroca/diff-dom-streaming/actions?query=workflow%3ATest" alt="Tests status">
<img src="https://github.com/aralroca/diff-dom-streaming/workflows/Test/badge.svg" /></a>
<a href="https://twitter.com/intent/follow?screen_name=aralroca">
<img src="https://img.shields.io/twitter/follow/aralroca?style=social&logo=x"
            alt="follow on Twitter"></a>

</div>

[badge-prwelcome]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square
[prwelcome]: http://makeapullrequest.com

The Diff DOM (Document Object Model) algorithm is used to compare two versions of the DOM, such as before and after an update on a web page. It aims to efficiently identify the changes between both DOMs, minimizing the number of manipulations required to update the user interface.

The Diff DOM Streaming library extends the traditional Diff DOM algorithm by introducing support for comparing a DOM node with a stream. This enables the library to process the changes incrementally as they occur during the diff process.

For more info, read this:

- [HTML Streaming Over the Wire | A Deep Dive](https://dev.to/aralroca/html-streaming-over-the-wire-a-deep-dive-2n20).
- [SPA-like Navigation Preserving Web Component State](https://dev.to/aralroca/spa-like-navigation-preserving-web-component-state-lh3)

## Getting started

### NPM

Install:

```sh
bun install diff-dom-streaming
```

Then import it:

```ts
import diff from "diff-dom-streaming";
```

### JSR

Install:

```sh
bunx jsr add @aralroca/diff-dom-streaming
```

Then import it:

```ts
import diff from "@aralroca/diff-dom-streaming";
```

### UNPKG

Just import it:

```tsx
import diff from "https://unpkg.com/diff-dom-streaming@latest";
```

## Using it

```ts
const res = await fetch(/* some url */);

// Diff between the current document and the stream:
await diff(document, res.body);
```

## API

`diff(oldNode: Node, stream: ReadableStream<Uint8Array>, options?: Options): Promise<void>`

This function performs a diffing operation between the `oldNode` and the DOM tree from a stream. It applies the necessary changes to update the `oldNode` accordingly. An optional `options` that include:

```ts
type Options = {
  // calback to handle each new docoument node during the streaming
  // (default: undefined)
  onNextNode?: NextNodeCallback;
  // update the DOM using document.startViewTransition (default: false)
  transition?: boolean;
  // callback to leave nodes alone, on both the old and the new tree: an
  // ignored node is never updated, moved or removed, and never counts as one
  // of the old children the diff has to prune (default: undefined)
  shouldIgnoreNode?: (node: Node | null) => boolean;
};
```

## Lists and `key` attribute

Keys help to identify which items have changed, are added, or are removed. Keys should be given to the elements inside the array to give the elements a stable identity:

```jsx 3
const numbers = [1, 2, 3, 4, 5];
const listItems = numbers.map((number) => (
  <li key={number.toString()}>{number}</li>
));
```

_(Example with JSX)_

The `diff-dom-streaming` library takes into account the `key` attribute for these cases, if it does not exist, then see if they have `id`.

## Transitions between pages (View Transition API)

You can activate the View Transition API updating the DOM with this property:

```diff
await diff(document, res.body, {
+ transition: true
})
```

> [!TIP]
>
> To access the transition with JavaScript/TypeScript you can access the global property `window.lastDiffTransition`

### Incremental vs full transition

Many times it will make more sense to use a complete transition instead of incremental, especially if we do not use suspense and we want a single transition at once instead of several, in this case, instead of using the configuration, we can use the View Transition API directly:

```diff
+ document.startViewTransition(async () => {
await diff(document, res.body, {
-  transition: true,
});
+});
```

## Strong Opinion on BODY Tag Attributes during Diffing

Our library has a strong opinion regarding the handling of the BODY tag attributes during the HTML diffing process. This approach is designed to provide greater flexibility and control over runtime modifications, such as themes, fonts, and other display properties that are managed through BODY tag attributes.

During the diffing process, all content within the HTML is typically updated to reflect the latest changes. However, we recognize that certain attributes of the BODY tag, like `class` and custom `data-attributes`, are often modified at runtime to control the presentation of the content. To avoid overwriting these runtime changes, our library's diffing algorithm specifically excludes these attributes from being updated.

### Key Points

- **Preservation of Attributes**: Attributes of the BODY tag (e.g., `class`, `data-attributes`) are preserved and not overwritten during the diffing process.
- **Consistent Display**: This ensures that runtime modifications, such as theme changes or other display-related adjustments, remain intact across navigations and updates.
- **Enhanced Customization**: Users can rely on the BODY tag attributes to manage display properties without concern for them being reset during content updates.

### Example

Consider the following scenario where the initial HTML and updated HTML are as follows:

#### Initial HTML

```html
<body class="light" data-theme="default">
  <div>Content A</div>
</body>
```

#### Updated HTML

After a navigation or content update, the new HTML may look like this:

```html
<body class="dark" data-theme="night">
  <div>Content B</div>
</body>
```

### Result After Diffing

After the diffing process, the resulting HTML will be as follows:

```html
<body class="light" data-theme="default">
  <div>Content B</div>
</body>
```

## Examples

In the repo we have examples for you to try.

### Locally

There are some examples:

- Run `bun run example:boxes`
- Run `bun run examples:spa-like`

### Stackblitz

You can run the boxes demo with Vanillajs [here](https://stackblitz.com/edit/diff-dom-streaming?file=index.js).

![ezgif-4-1ff18912f4](https://github.com/aralroca/diff-dom-streaming/assets/13313058/f18c01c0-4dfe-473f-8817-fb905adc20c1)

## Acknowledgments

The Diff DOM Algorithm with HTML Streaming is inspired by the [set-dom](https://github.com/DylanPiercey/set-dom) library by [@dylan_piercey](https://twitter.com/dylan_piercey) and a technique for parsing streams pioneered by [@jaffathecake](https://twitter.com/jaffathecake).

## Contributing

See [Contributing Guide](CONTRIBUTING.md) and please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
