# Tailwind CSS — 랜딩·마케팅 UI 구현

## 사용 시점

- 일관된 spacing/typography 스케일로 빠른 UI 제작
- 마케팅 페이지, 프로토타입 → 프로덕션 정적 HTML
- 컴포넌트보다 **유틸리티 조합**이 유리한 랜딩 섹션

## 핵심 패턴

- HTML에 유틸 조합: `class="flex gap-4 p-6 bg-zinc-950 text-white"`
- 반응형: `sm:` `md:` `lg:` `xl:`
- 상태: `hover:` `focus:` `active:` `group-hover:`
- 임의 값 (절제): `w-[42rem]`, `bg-[#0b1220]`
- 다크 모드: `dark:` + class 전략
- 반복 패턴: 컴포넌트 분리 우선, `@apply`는 소량만
- CDN 사용 시: `<script src="https://cdn.tailwindcss.com"></script>` 또는 빌드 파이프라인 명시

## 흔한 실수

- 프로덕션에서 클래스 미생성 → content 경로 누락
- 동적 클래스 조합 (`"text-" + color`) → 매핑 객체 사용
- `@apply` 과다 → utility-first 이점 상실
- class 목록만 길고 구조 없음 → 섹션/컴포넌트로 분리

## 레시피

### 1) CTA 버튼
```html
<button class="inline-flex items-center justify-center rounded-lg px-5 py-3
               bg-teal-700 text-white font-medium tracking-tight
               hover:bg-teal-600 active:bg-teal-800
               focus:outline-none focus:ring-2 focus:ring-teal-500/50">
  시작하기
</button>
```

### 2) 반응형 히어로
```html
<section class="mx-auto max-w-6xl px-6 py-16">
  <div class="grid gap-10 lg:grid-cols-2 lg:items-center">
    <div>
      <h1 class="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
        빠르게 아름다운 사이트를 만드세요.
      </h1>
      <p class="mt-4 text-zinc-600 dark:text-zinc-400">
        Tailwind로 CSS 싸움 없이 일관된 간격과 타이포를 유지합니다.
      </p>
    </div>
    <div class="border border-zinc-200 bg-zinc-50 p-6">
      <!-- media placeholder — prefer full-bleed imagery over card chrome -->
    </div>
  </div>
</section>
```
### 3) 동적 클래스 (안전)
```js
const toneClass = {
  success: 'bg-emerald-600',
  danger: 'bg-rose-600',
  info: 'bg-sky-600',
}[tone];
```

### 4) 랜딩 섹션 간격 기본값
- 섹션 세로: `py-16` ~ `py-24`
- 컨테이너: `mx-auto max-w-6xl px-6`
- 카드: `border p-6` (불필요한 `rounded-2xl shadow` 남발 금지; interaction container일 때만)
- 그리드: `grid gap-8 md:grid-cols-2 lg:grid-cols-3`

## 사용자에게 확인할 것

- 빌드 도구 (CDN only / Vite / Next)?
- 디자인 시스템 vs 일회성 페이지?
- 다크 모드? RTL? 접근성 제약?
