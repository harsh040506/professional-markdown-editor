// The welcome document, shown when the editor opens with no file and no draft. It doubles as a tour
// of every feature, so keep it in step with what the editor supports. test/roundtrip.mjs checks that it
// survives open -> save unchanged.
// String.raw keeps the TeX backslashes literal; "\`" is written for backticks inside the template
// literal and turned back into "`" by the replace at the end.
export const SAMPLE = String.raw`# Welcome to your Markdown editor

This page is the document. Click anywhere and type: there is no separate Markdown view. Everything you write is saved as plain Markdown, and everything stays in your browser. Nothing is uploaded.

## Write the way you already do

Markdown shortcuts turn into formatting as you type: \`#\` and a space for a heading, \`-\` for a list, \`[ ]\` for a checklist, \`>\` for a quote and three backticks for code. Select text to get the formatting bar, or type **/** on an empty line to insert anything.

- [x] Edit directly on the page
- [x] Format with the selection bar or shortcuts
- [ ] Export to PDF, Word or HTML when you are done

> Tip: press Ctrl+/ (or ⌘/ on a Mac) to see every keyboard shortcut.

## Your documents

Press Ctrl+S (⌘S on a Mac) to save into your **browser library**. Each save keeps the text it replaces, so **Version history** can bring it back. In Chrome, Edge and other Chromium browsers, **Open folder…** edits a real folder on your computer instead, with your files exactly as they are. Either way, the file is plain \`.md\`, so you can take it anywhere.

## Equations

Inline math sits in a sentence, like the sigmoid $\sigma(z) = \frac{1}{1+e^{-z}}$, and display math gets its own line:

$$
\nabla_\theta \mathcal{L} = \frac{1}{N}\sum_{i=1}^{N} \left(\hat y_i - y_i\right) x_i
$$

Click an equation to edit it, with a live preview. In a Word export, equations stay real, editable Word equations.

## Code

\`\`\`python
import numpy as np

def softmax(z):
    e = np.exp(z - z.max())   # subtract the max for numerical stability
    return e / e.sum()
\`\`\`

## Tables

| Format | Best for | Keeps math |
|---|---|:---:|
| PDF | Printing and sharing | Yes |
| Word (.docx) | Editing in Office | Yes, as equations |
| HTML | One file that opens anywhere | Yes |
| Markdown | Version control | Yes |

## Collapsible sections

<details><summary>What does a collapsible section look like?</summary>

Like this. Use them for answers, long derivations or anything a reader should open on purpose. When you export, you can show their contents or keep only the summaries, which is handy for answer keys.
</details>

## Diagrams

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Review]
  B --> C{Ready?}
  C -->|Yes| D[Export]
  C -->|No| A
\`\`\`

Double-click a diagram to edit its source.
`.replace(/\\`/g, "`");
