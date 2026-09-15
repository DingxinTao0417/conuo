import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

const components: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
  h1: ({ children }) => <h5>{children}</h5>,
  h2: ({ children }) => <h5>{children}</h5>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h5>{children}</h5>,
  h6: ({ children }) => <h6>{children}</h6>,
  table: ({ children }) => (
    <div className="region-study-table">
      <table>{children}</table>
    </div>
  ),
};

export default function RegionStudyMarkdown({ content }: { content: string }) {
  return (
    <div className="region-study-markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={() => ""}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              trust: false,
              maxExpand: 1000,
              maxSize: 10,
              strict: "ignore",
              // KaTeX may mutate this object for \gdef; never share it with another result.
              macros: {},
            },
          ],
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
