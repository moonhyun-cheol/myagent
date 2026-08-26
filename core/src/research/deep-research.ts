import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { CloudChatService } from '../providers/cloud-chat.js';

export interface ResearchResult {
  id: string;
  title: string;
  markdown: string;
  file_path: string;
  sources: string[];
  steps: string[];
}

export interface DeepResearchOptions {
  llmProviderId?: string | null;
  llmModelId?: string | null;
}

export class DeepResearchPipeline {
  constructor(
    private readonly outputDir: string,
    private readonly cqrRoot: string,
    private readonly providerStore: ProviderStore,
    private readonly cloudChat: CloudChatService,
  ) {}

  async run(query: string, sessionId: string, opts?: DeepResearchOptions): Promise<ResearchResult> {
    const id = randomUUID();
    const sessionDir = path.join(this.outputDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const steps = ['Research planning', 'Desk research (LLM)'];
    const llmId = opts?.llmProviderId ?? this.providerStore.getDefaultId();
    let summary = '';

    if (llmId) {
      try {
        const prompt = [
          `「${query}」에 대한 한국어 리서치 초안을 작성하세요.`,
          '',
          'Rules:',
          '- MY Agent does not perform live web search for deep research.',
          '- Do NOT invent URLs, statistics, or report citations.',
          '- Start with this exact line: ※ LLM 일반 지식 기반 초안입니다 (실시간 웹 검색 없음).',
          '- Say "확인 필요" where you lack verified data; avoid generic industry template filler.',
        ].join('\n');
        const out = await this.cloudChat.complete(llmId, prompt, undefined, [], undefined, {
          modelId: opts?.llmModelId ?? undefined,
        });
        summary = out.content.trim();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        summary = `_Desk research failed: ${msg}_`;
        steps[1] = 'Desk research (LLM error)';
      }
    } else {
      summary = [
        '**LLM provider required for deep research.**',
        '',
        'Register Ollama, company OpenRouter, or another provider under Models → API Providers.',
      ].join('\n');
      steps[1] = 'Desk research (skipped — no LLM)';
    }

    const markdown = `# Deep research: ${query}

## Summary

${summary}

## Steps

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;

    const filePath = path.join(sessionDir, `${id}.md`);
    assertWritablePath(filePath, this.cqrRoot);
    writeFileSync(filePath, markdown, 'utf8');

    return {
      id,
      title: query.slice(0, 80),
      markdown,
      file_path: filePath,
      sources: [],
      steps,
    };
  }
}
