interface PaneToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}

/** Matte light switch — accent track + pale knob (on = right). */
export function PaneToggle({ on, onChange, label = 'Preview' }: PaneToggleProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 select-none">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label} ${on ? '켜짐' : '꺼짐'}`}
        onClick={() => onChange(!on)}
        className={`relative h-7 w-12 rounded-md border transition ${
          on ? 'border-accent bg-accent' : 'border-line bg-[#cbd2cf]'
        }`}
      >
        <span
          className={`absolute top-0.5 h-[22px] w-[22px] rounded-[5px] bg-white shadow transition-all ${
            on ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}
