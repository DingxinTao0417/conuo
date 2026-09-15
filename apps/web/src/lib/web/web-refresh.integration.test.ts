import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWebPageFetcher } from "./fetch-page";
import { extractArticle } from "./extract-article";
import { addWebSource, makeCapturedWebSource } from "../web-import";
import { createEmptyWorkspace } from "../seed";
import { refreshWebSource, getSourceVersion } from "../source-versions";
import { resolveCitation, resolveSavedCitation, retrieveEvidence } from "../retrieval";
import { workspaceSchema } from "../supabase/validation";
import { questionContextKey } from "../question-context";
import type { AnswerRequest } from "../types";

describe("AT-06 controlled origin changes", () => {
  it("fetches two real HTTP bodies, retains the first capture and cites only the new body in new questions", async () => {
    let release = 1;
    let requests = 0;
    const bodies = [
      "Amberdelta is the original observation in the first edition. The measured temperature is ten degrees. This edition describes a preliminary experiment and its conditions. A reader must be able to return to this original observation after the article is revised, because notes and answers describe what was actually written at the time.",
      "Cobaltepsilon is the revised observation in the second edition. The measured temperature is twenty degrees. This edition corrects the calibration of the instrument and explains the new conditions. New questions should use this corrected observation, while earlier notes and answers continue to refer to the edition that was available when they were recorded.",
    ];
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Controlled article</title></head><body><main><article><h1>Edition ${release}</h1><p>${bodies[release - 1]}</p></article></main></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      // Only this trusted test transport redirects a validated URL to an ephemeral local origin.
      // Production URL validation and its private-address prohibition remain unchanged.
      const fetchPage = createWebPageFetcher({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: (options, response) =>
          httpRequest(
            { ...options, hostname: "127.0.0.1", port, agent: false, lookup: undefined, family: 4 },
            response,
          ),
      });
      const url = "http://controlled.example/article#study";
      const capture = async () => {
        const page = await fetchPage(url);
        const extracted = extractArticle(page.html, page.finalUrl);
        expect(extracted.kind).toBe("article");
        return makeCapturedWebSource({
          preview: {
            ...extracted,
            originalUrl: url,
            finalUrl: page.finalUrl,
            capturedAt: page.fetchedAt,
          },
          scope: "article",
          spaceId: "",
          aiAllowed: true,
        });
      };
      const first = await capture();
      let workspace = addWebSource(createEmptyWorkspace(), first);
      const request: AnswerRequest = {
        question: "Amberdelta",
        sourceId: first.id,
        sourceIds: [],
        spaceId: "inbox",
        scope: "document",
      };
      const oldAnswer = retrieveEvidence(workspace, request);
      expect(oldAnswer.citations).toHaveLength(1);
      const oldKey = questionContextKey(workspace, request);
      const originalSnapshot = JSON.stringify(first);
      // Simulate changing the same origin's article; opening or asking never triggers refresh.
      release = 2;
      expect(requests).toBe(1);
      expect(retrieveEvidence(workspace, request).citations).toEqual(oldAnswer.citations);
      const candidate = await capture();
      expect(requests).toBe(2);
      expect(workspace.sources[0]).toEqual(first); // A preview is not a save.
      workspace = refreshWebSource(workspace, first.id, first.versionId, candidate);
      expect(JSON.stringify(first)).toBe(originalSnapshot);
      expect(workspace.sources).toHaveLength(1);
      expect(workspace.sources[0].versionId).toBe(candidate.versionId);
      expect(questionContextKey(workspace, request)).not.toBe(oldKey);
      expect(retrieveEvidence(workspace, request).citations).toEqual([]);
      const newAnswer = retrieveEvidence(workspace, { ...request, question: "Cobaltepsilon" });
      expect(newAnswer.citations).toHaveLength(1);
      expect(newAnswer.citations[0]).toMatchObject({
        sourceId: first.id,
        versionId: candidate.versionId,
      });
      // The same JSON shape is written by IndexedDB and the workspace API.
      const reopened = workspaceSchema.parse(JSON.parse(JSON.stringify(workspace)));
      expect(getSourceVersion(reopened.sources[0], first.versionId)?.text).toContain(bodies[0]);
      expect(resolveSavedCitation(reopened, oldAnswer.citations[0])?.chunk.text).toBe(bodies[0]);
      expect(resolveCitation(reopened, oldAnswer.citations[0])).toBeNull();
      expect(resolveCitation(reopened, newAnswer.citations[0])?.chunk.text).toBe(bodies[1]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
