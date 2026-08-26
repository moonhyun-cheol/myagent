# 디자인 우선 UI 프롬프팅

흐릿한 아이디어를 **일관된 UI를 만드는 타이트한 스펙**으로 바꿉니다.

## 핵심 원칙

**위시리스트가 아니라 디자인 시스템처럼 프롬프트를 작성한다.**

## 프롬프트 골격 (복사·채우기)

```text
GOAL
- 무엇을 만드는가? (랜딩 히어로 / 온보딩 / 대시보드 / 캐러셀 슬라이드)
- 누구를 위한가? (페르소나)
- 성공 기준은? (명확성, 전환, 무드)

FORMAT
- 크기/비율: (예: 1440×900 뷰포트)
- 안전 여백: (예: 24px / 48px)

LAYOUT (말로 그린 와이어프레임)
- 그리드: (예: 12-col, max-w-6xl)
- 배치: (예: 텍스트 좌 / 이미지 우)
- 위계: H1 → 서브헤드 → 본문 → CTA

TYPE SYSTEM
- 폰트 무드: (예: Fraunces + Source Sans 3 / Pretendard / IBM Plex — Inter 금지)
- 굵기: (H1 700, body 400)
- 행간: (H1 tight, body readable)
- 자간: (라벨은 약간 넓게)

COLOR + MATERIAL
- 배경: (hex — flat single color만으로 끝내지 말 것)
- 텍스트: (primary / secondary)
- 악센트 1개만: (teal / amber / forest — indigo·purple 기본값 금지)
- 텍스처: (미세 grain, 과한 HDR 금지)

IMAGERY / UI STYLE
- UI 스타일: (minimal / glass / editorial / playful 3D)
- 사진: 조명·크롭·텍스처 규칙
- 3D: 재질·조명·부드러움

COPY (정확히 렌더)
- Line 1:
- Line 2:
- ...

CONSTRAINTS (한 번에 1–2개만 변경)
- FONT: ___
- STYLE: ___
- MODE: ___ (light/dark)

NEGATIVE
- 워터마크·로고 남발 금지
- 제공 문구 외 추가 텍스트 금지
```

## 일관성 규칙

### 1) 시스템을 고정한 뒤 변형
- 첫 출력: **레이아웃 + 위계 + 카피** 확정
- 변형: **한 변수만** 변경 (악센트 색, 카드 배치, 배경 톤)

### 2) 타이포는 취약
- HTML/CSS로 직접 타이포 구현 (웹 랜딩 모드에서는 Figma 2-pass보다 코드가 우선)

### 3) Constraints 카드
```text
Constraints
FONT  Pretendard (or distinctive pair — not Inter)
STYLE  MINIMAL EDITORIAL
MODE  LIGHT
```
### 4) 레퍼런스 팩
- 참고 스타일은 `refs/` 등 워크스페이스 폴더에 저장하고 프롬프트에 명시

## 빠른 반복 체크리스트

- 간격: margin, leading, baseline rhythm
- 대비: 배경 vs 텍스트
- 위계: 히어로 1줄 + 서포트 1줄
- 악센트는 하나만
- 텍스처: grain 추가, 과한 스무딩 제거

## 모호할 때 질문

- 이 화면의 단일 메시지는?
- H1 / 서브 / CTA 위계는?
- 스타일 레인: 미니멀 에디토리얼 vs 3D vs 글래스?
- 고정 제약: 폰트, 색, 간격, 그리드?
