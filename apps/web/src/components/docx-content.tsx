import type { DocxBlock } from "@/lib/docx-structure";

const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Render only the restricted text structure produced by docx-structure.ts. */
export default function DocxContent({ blocks }: { blocks: DocxBlock[] }) {
  return blocks.map((block, blockIndex) => {
    if (block.type === "heading") {
      const Heading = headingTags[Math.max(1, Math.min(6, block.level)) - 1];
      return (
        <Heading data-docx-heading-id={block.id} id={block.id} key={block.id}>
          {block.text}
        </Heading>
      );
    }
    if (block.type === "paragraph") {
      return (
        <p className="reader-plain-paragraph" key={`paragraph-${blockIndex}`}>
          {block.text}
        </p>
      );
    }
    if (block.type === "list") {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={`list-${blockIndex}`}>
          {block.items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{item}</li>
          ))}
        </List>
      );
    }
    return (
      <table key={`table-${blockIndex}`}>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) =>
                cell.header ? (
                  <th key={`cell-${cellIndex}`}>{cell.text}</th>
                ) : (
                  <td key={`cell-${cellIndex}`}>{cell.text}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  });
}
