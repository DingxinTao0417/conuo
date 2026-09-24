import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AskPanel from "./ask-panel";

describe("AskPanel tutor mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the direct-answer and guided-thinking switch when enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_TUTOR_MODE", "on");
    const markup = renderToString(
      <AskPanel
        ask={
          {
            input: "",
            setInput: vi.fn(),
            deepThinking: false,
            setDeepThinking: vi.fn(),
            tutorMode: false,
            setTutorMode: vi.fn(),
            busy: false,
            stopping: false,
            answerDraft: null,
            answerPhase: "retrieving",
            error: "",
            setError: vi.fn(),
            historyOpen: false,
            setHistoryOpen: vi.fn(),
            selectedConversationId: null,
            setSelectedConversationId: vi.fn(),
            newConversation: false,
            setNewConversation: vi.fn(),
            expandedCitationKey: null,
            setExpandedCitationKey: vi.fn(),
            toggleCitationKey: vi.fn(),
            saveTargetMessageId: null,
            setSaveTargetMessageId: vi.fn(),
            knowledgePageTargetId: "",
            setKnowledgePageTargetId: vi.fn(),
            openKnowledgeSaveTarget: vi.fn(),
            questionInput: { current: null },
            chatEnd: { current: null },
            focusInput: vi.fn(),
            running: vi.fn(() => false),
            abort: vi.fn(),
            stop: vi.fn(),
            beginNewConversation: vi.fn(),
            reset: vi.fn(),
            run: vi.fn(),
          } as never
        }
        surface={{
          id: "tutor-test",
          label: "问答",
          title: "问答",
          description: "",
          placeholder: "输入问题",
          footnote: "",
          historyTitle: "历史",
          historyEmpty: "暂无",
          empty: { title: "", text: "", prompts: [] },
        }}
        scope={{
          active: "document",
          options: ["document"],
          locked: false,
          onChange: vi.fn(),
        }}
        conversation={{}}
        messages={[]}
        evidence={{
          citationIssue: () => null,
          noteEvidenceIssue: () => null,
          onOpenCitation: vi.fn(),
        }}
        composer={{ readOnly: false, onSubmit: vi.fn() }}
        onClose={vi.fn()}
      />,
    );
    expect(markup).toContain("直接解答");
    expect(markup).toContain("引导我思考");
  });
});
