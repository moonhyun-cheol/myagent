#!/usr/bin/env python3
"""Generate MY Agent project overview PDF report."""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

from fpdf import FPDF

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
VERSION = MANIFEST.get("version", "1.0.0")
OUT_DIR = ROOT / "deploy" / "output"
OUT_FILE = OUT_DIR / f"MYAgent-Project-Report-v{VERSION}.pdf"

FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\malgun.ttf"),
    Path(r"C:\Windows\Fonts\malgunsl.ttf"),
    Path("/usr/share/fonts/truetype/nanum/NanumGothic.ttf"),
]


def pick_font() -> Path:
    for p in FONT_CANDIDATES:
        if p.is_file():
            return p
    print("ERROR: Korean font not found (malgun.ttf).", file=sys.stderr)
    sys.exit(1)


class ReportPDF(FPDF):
    def __init__(self) -> None:
        super().__init__(orientation="P", unit="mm", format="A4")
        self.font_path = pick_font()
        self.add_font("KR", "", str(self.font_path))
        self.set_auto_page_break(auto=True, margin=18)
        self._section_num = 0

    def header(self) -> None:
        if self.page_no() <= 1:
            return
        self.set_font("KR", size=8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 6, f"MY Agent 프로젝트 보고서 v{VERSION}", align="L")
        self.ln(4)

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("KR", size=8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, f"- {self.page_no()} -", align="C")

    def cover(self) -> None:
        self.add_page()
        self.set_font("KR", size=28)
        self.set_text_color(20, 40, 80)
        self.ln(50)
        self.cell(0, 14, "MY Agent", align="C", new_x="LMARGIN", new_y="NEXT")
        self.set_font("KR", size=16)
        self.set_text_color(60, 60, 60)
        self.cell(0, 10, "프로젝트 전체 설명 보고서", align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(8)
        self.set_font("KR", size=11)
        self.cell(0, 8, f"버전 {VERSION}  |  생성일 {date.today().isoformat()}", align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(20)
        self.set_font("KR", size=10)
        self.set_text_color(80, 80, 80)
        body = (
            "휴대용 AI 워크벤치 — 채팅, 스킬, 작업 폴더, 모델/API 관리, "
            "라이선스 활성화를 WebView2 데스크톱 앱으로 제공하는 사내용 솔루션."
        )
        self.multi_cell(0, 7, body, align="C")

    def section(self, title: str) -> None:
        self._section_num += 1
        self.ln(4)
        self.set_font("KR", size=14)
        self.set_text_color(20, 60, 120)
        self.cell(0, 10, f"{self._section_num}. {title}", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(20, 60, 120)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(4)

    def sub(self, title: str) -> None:
        self.ln(2)
        self.set_font("KR", size=11)
        self.set_text_color(40, 40, 40)
        self.cell(0, 8, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def body(self, text: str) -> None:
        self.set_x(self.l_margin)
        self.set_font("KR", size=9.5)
        self.set_text_color(30, 30, 30)
        self.multi_cell(0, 5.5, text)
        self.ln(2)

    def bullet(self, items: list[str]) -> None:
        self.set_x(self.l_margin)
        self.set_font("KR", size=9.5)
        self.set_text_color(30, 30, 30)
        for item in items:
            self.set_x(self.l_margin)
            self.multi_cell(0, 5.5, f"- {item}")
        self.ln(2)

    def table(self, headers: list[str], rows: list[list[str]], col_widths: list[float] | None = None) -> None:
        if col_widths is None:
            w = (self.w - self.l_margin - self.r_margin) / len(headers)
            col_widths = [w] * len(headers)
        self.set_font("KR", size=8.5)
        self.set_fill_color(230, 236, 245)
        self.set_text_color(20, 40, 80)
        for i, h in enumerate(headers):
            self.cell(col_widths[i], 7, h, border=1, fill=True)
        self.ln()
        self.set_text_color(30, 30, 30)
        for row in rows:
            y0 = self.get_y()
            x0 = self.l_margin
            heights = []
            lines_per_cell: list[list[str]] = []
            for i, cell in enumerate(row):
                self.set_xy(x0 + sum(col_widths[:i]), y0)
                lines = self.multi_cell(col_widths[i], 5.5, cell, border=0, split_only=True)
                lines_per_cell.append(lines)
                heights.append(len(lines) * 5.5)
            row_h = max(heights) if heights else 5.5
            for i, cell in enumerate(row):
                self.set_xy(x0 + sum(col_widths[:i]), y0)
                self.multi_cell(col_widths[i], 5.5, cell, border=1)
            self.set_y(y0 + row_h)
        self.set_x(self.l_margin)
        self.ln(3)


def build_report() -> None:
    pdf = ReportPDF()
    pdf.cover()
    pdf.add_page()

    pdf.section("프로젝트 개요")
    pdf.body(
        "MY Agent는 Windows와 로컬 네트워크 환경에서 동작하는 휴대용 AI 워크벤치입니다. "
        "MY_Open_Codex를 대체하는 그린필드 프로젝트로, 채팅·스킬·작업 폴더·모델/API 관리·"
        "라이선스 활성화를 하나의 WebView2 데스크톱 애플리케이션으로 통합합니다."
    )
    pdf.sub("목적")
    pdf.bullet([
        "사내 직원 PC에서 NAS Ollama 기반 LLM + 클라우드 API를 단일 UI로 사용",
        "컨셉 RA, 시장조사 RA, 웹개발, 코드 에이전트 등 번들 스킬 제공",
        "사용자 정의 스킬 CRUD 및 작업 폴더 기반 프로젝트 트리 관리",
        "머신·AD 계정 바인딩 라이선스 및 중앙 활성화 서버 지원",
    ])
    pdf.sub("대상 사용자")
    pdf.table(
        ["역할", "설명"],
        [
            ["사용자", "MYAgent.exe 실행 → 선택적 활성화 → 채팅·스킬·모델 사용"],
            ["관리자", "npm run publish, 활성화 서버 운영, allowlist·tools/commands 진단"],
            ["개발자", "npm run build, publish/delta, rulebook·스킬 동기화"],
        ],
        [35, 145],
    )

    pdf.section("시스템 아키텍처")
    pdf.body(
        "데스크톱 셸(C# WebView2)이 로컬 Node.js API 서버(127.0.0.1:10200)에 연결하고, "
        "React 워크스페이스 UI(ui/workspace/dist)를 표시합니다. API는 채팅 오케스트레이터, 라우터, 프로바이더, "
        "라이선스 게이트, 세션·프로젝트 저장소를 조율합니다."
    )
    pdf.table(
        ["계층", "기술·경로"],
        [
            ["데스크톱 셸", "shell/CqrPa.Shell — C# .NET 8, Microsoft WebView2"],
            ["API 서버", "core/dist/main.js — TypeScript ESM, native http (Express 미사용)"],
            ["UI", "ui/workspace/ — React + Vite workspace"],
            ["데이터", "data/ — vault, sessions, projects, skills, models, attachments"],
            ["런타임", "runtime/node, llama-cpp, sd-cpp, pipeline-venv (선택)"],
            ["활성화", "activation-server/ — LAN port 10201, 즉시 라이선스 발급"],
        ],
        [35, 145],
    )

    pdf.section("디렉터리 구조")
    pdf.table(
        ["경로", "역할"],
        [
            ["core/src/", "API·채팅·스킬·라이선스·보안 TypeScript 소스"],
            ["core/config/defaults/", "providers, skills, deploy-defaults, OWUI 큐레이션"],
            ["ui/workspace/", "chat, notebook, models, skills, Preview"],
            ["tools/", "build, publish, verify, cqr-admin, activation-server"],
            ["data/", "런타임 사용자 데이터 (UPDATE 시 보존)"],
            ["rulebook/", "제품 명세·룰북 (배포·델타 포함)"],
            ["deploy/output/", "install zip, delta zip, 본 보고서 PDF"],
        ],
        [45, 135],
    )

    pdf.section("주요 기능 (Phase별)")
    pdf.table(
        ["Phase", "기능"],
        [
            ["2–4", "WebView2 셸, 파일 첨부, 로컬 GGUF, L1 라우터, 이미지·리서치"],
            ["5–6", "API 프로바이더(MiniMax/OpenAI/Gemini/Custom), SSE 스트리밍, 세션"],
            ["7–9", "DALL·E, DOCX 추출, L2 코사인 라우터, NAS Ollama, local_only"],
            ["10", "publish/delta UPDATE, 4_ADMIN 진단, AD 라이선스 자동 import"],
            ["11", "중앙 활성화 서버, 무제한 라이선스, 오프라인 동작"],
            ["최근", "스킬 탭·사용자 스킬 CRUD, workspace 트리, 세션 이동·삭제, OWUI v2"],
        ],
        [22, 158],
    )

    pdf.section("API 엔드포인트 요약")
    pdf.body("모든 API는 127.0.0.1에만 바인딩됩니다 (api-server.ts).")
    pdf.sub("헬스·라이선스·관리")
    pdf.bullet(["GET /health, /license/status, /license/features", "GET /admin/diagnostics"])
    pdf.sub("설정·셋업")
    pdf.bullet([
        "GET /config — PUT /config/local-only, /config/dev-workspace",
        "GET /setup/status, /setup/machine-id — POST /setup/activate",
    ])
    pdf.sub("채팅·도구")
    pdf.bullet([
        "POST /chat, /chat/stream (SSE)",
        "POST /generate/image, /research",
    ])
    pdf.sub("모델·프로바이더")
    pdf.bullet([
        "GET /models, /models/picker, /models/runtime",
        "GET /providers — PUT/DELETE /providers/:id/key — POST /providers/:id/test",
    ])
    pdf.sub("워크스페이스·스킬·세션")
    pdf.bullet([
        "GET /workspace, /projects, /skills, /sessions",
        "POST/PUT/DELETE projects, skills, sessions (cross-tree 이동 지원)",
    ])

    pdf.section("보안 및 라이선스")
    pdf.table(
        ["영역", "구현"],
        [
            ["라이선스", "Ed25519 서명 license.ocx, machine+Windows user 바인딩"],
            ["읽기 전용", "미서명·만료 시 license.assertWritable()로 쓰기 차단"],
            ["Vault", "provider-keys.json AES-256-GCM (machine ID 키), publish zip 제외"],
            ["경로 가드", "NAS(\\\\nas, \\\\nas3) 쓰기 차단, CQR_ROOT 외부 쓰기 금지"],
            ["작업 폴더", "dev-workspace-guard — 존재·디렉터리·NAS 검증"],
            ["활성화", "activation-server policy.json — org_id, feature flags, license_days"],
        ],
        [35, 145],
    )

    pdf.section("스킬·워크스페이스·채팅")
    pdf.sub("번들 스킬 (읽기 전용)")
    pdf.table(
        ["ID", "라벨", "모드"],
        [
            ["cqr_concept", "CQR 컨셉 RA", "cqr_concept"],
            ["cqr_market", "CQR 시장조사 RA", "cqr_market (Python pipeline)"],
            ["web_dev", "웹개발", "web_dev"],
            ["code_agent", "코드 에이전트", "code_agent"],
        ],
        [35, 55, 90],
    )
    pdf.sub("사용자 스킬")
    pdf.bullet([
        "저장: data/skills/index.json + {id}.md",
        "API: GET/POST/PUT/DELETE /skills",
        "채팅 모드 user:{id}, + 메뉴·스킬 탭 연동",
    ])
    pdf.sub("워크스페이스·세션")
    pdf.bullet([
        "PUT /config/dev-workspace → workspace_root 프로젝트 자동 생성",
        "트리: workspace_root → folder → project → sessions",
        "PUT /sessions/:id { project_id } — cross-tree 이동",
        "DELETE projects/sessions, workspace_root 삭제 불가(403)",
    ])
    pdf.sub("채팅")
    pdf.bullet([
        "L1 키워드 + L2 코사인 유사도 라우터",
        "SSE 스트리밍, 최근 20턴 히스토리 + 첨부(PDF/DOCX) 컨텍스트",
    ])

    pdf.section("모델·프로바이더")
    pdf.sub("API 프로바이더")
    pdf.bullet([
        "Ollama(NAS), MiniMax, OpenAI, Anthropic, Google Gemini, Open WebUI(Custom)",
        "키: data/vault/provider-keys.json (머신 바인딩 암호화)",
    ])
    pdf.sub("Open WebUI 모델 큐레이션 (v2)")
    pdf.bullet([
        "openwebui-model-curate.json + remote-model-curate.ts",
        "family dedupe (GPT/Claude/Gemini 등 최신 1개 유지)",
        "Perplexity reasoning, Gemini 이미지 1종, 최대 ~18 모델",
        "local_only 모드: Ollama + 로컬 GGUF만 허용",
    ])

    pdf.section("배포·업데이트")
    pdf.table(
        ["방식", "명령", "산출물"],
        [
            ["전체 설치", "npm run publish", "MYAgent-v*-install.zip"],
            ["간략(델타)", "npm run publish:delta + UPDATE.bat", "core/dist, core/config/defaults, ui, manifest, rulebook"],
            ["사전 점검", "npm run predeploy:full", "인코딩·패리티·빌드·verify"],
            ["진단", "tools/commands/diagnostics.bat", "GET /admin/diagnostics"],
        ],
        [35, 55, 90],
    )
    pdf.body(
        "install zip: Portable Node(bundled/deferred), pipeline-venv(prebuilt/deferred), "
        "조직 전용 모듈은 별도 배포하며, data/vault secrets는 zip에 포함되지 않습니다. "
        "UPDATE.bat(간략)은 data/·logs/·runtime/을 보존하면서 앱·defaults·UI·룰북만 갱신합니다. "
        "셸·brand_manager·runtime 변경은 전체 install이 필요합니다."
    )

    pdf.section("룰북 (Rulebook)")
    pdf.body(
        "제품 명세는 rulebook/에 번들되어 install·delta에 포함됩니다. "
        "npm run build 시 tools/build-rulebook.mjs가 manifest 버전과 동기화된 "
        "RULEBOOK_MY_AGENT_MAIN_v{version}.md를 생성합니다."
    )
    pdf.table(
        ["Rule ID", "우선순위", "요약"],
        [
            ["R-001", "P0", "data/ UPDATE 시 보존"],
            ["R-002", "P0", "vault 비밀 publish 제외"],
            ["R-003", "P0", "NAS 쓰기 차단"],
            ["R-004", "P0", "번들 스킬 읽기 전용"],
            ["R-011", "P1", "delta에 defaults+rulebook 포함"],
            ["R-030–031", "P2", "사용자 스킬 CRUD, user:{id} 모드"],
            ["R-040–041", "P2", "세션·프로젝트 이동/삭제"],
        ],
        [25, 25, 130],
    )

    pdf.section("기술 스택 및 실행 방법")
    pdf.table(
        ["구분", "기술"],
        [
            ["언어", "TypeScript 6.x (ESM), JavaScript, C# .NET 8, PowerShell"],
            ["런타임", "Node.js 22+, WebView2, Python pipeline-venv (시장조사)"],
            ["추론", "Ollama OpenAI-compatible, llama.cpp, Open WebUI 프록시"],
            ["이미지", "OpenAI DALL·E, runtime/sd-cpp (선택)"],
            ["암호화", "Ed25519 라이선스, AES-256-GCM vault"],
        ],
        [35, 145],
    )
    pdf.sub("개발·실행")
    pdf.bullet([
        "npm install && npm run build && npm run build:exe",
        "copy data\\vault\\license.ocx.example → license.ocx",
        "MYAgent.exe (WebView2)",
        "브라우저 API만: node core\\dist\\main.js → http://127.0.0.1:10200",
    ])

    pdf.section("부록 — 핵심 설정 파일")
    pdf.table(
        ["파일", "용도"],
        [
            ["manifest.json", f"제품 버전 ({VERSION})"],
            ["core/config/defaults/deploy-defaults.json", "NAS Ollama, OWUI, 활성화 URL"],
            ["core/config/defaults/providers.json", "프로바이더 카탈로그"],
            ["core/config/defaults/openwebui-model-curate.json", "모델 큐레이션 v2"],
            [".rulebook-link.yml", "번들 룰북 링크"],
            ["activation-server/policy.json", "활성화 서버 정책"],
        ],
        [75, 105],
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pdf.output(str(OUT_FILE))
    print(f"Report PDF -> {OUT_FILE}")


if __name__ == "__main__":
    build_report()
