import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ mono, invalid, className, ...rest }: InputProps) {
  return (
    <input
      spellCheck={false}
      autoComplete="off"
      className={`input${mono ? " mono" : ""}${invalid ? " is-invalid" : ""}${className ? ` ${className}` : ""}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`select${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </select>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** Small trailing marker, e.g. availability dot. */
  badge?: ReactNode;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  const move = (dir: 1 | -1) => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      className={`segmented segmented-${size}`}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          className={`segment${o.value === value ? " is-selected" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.badge}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
      <label htmlFor={id} className="toggle-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </label>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  warn,
  children,
  htmlFor,
  inline,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  warn?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  inline?: boolean;
}) {
  return (
    <div className={`field${inline ? " field-inline" : ""}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-body">
        {children}
        {error ? <div className="field-msg is-error">{error}</div> : warn ? <div className="field-msg is-warn">{warn}</div> : hint ? <div className="field-msg">{hint}</div> : null}
      </div>
    </div>
  );
}

/** Numeric input that commits on blur / Enter and clamps to [min, max]. */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  id,
  width = 96,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  id?: string;
  width?: number;
}) {
  const commit = (el: HTMLInputElement) => {
    const n = Number(el.value);
    if (!Number.isFinite(n)) {
      el.value = String(value);
      return;
    }
    const v = Math.min(max, Math.max(min, step < 1 ? Math.round(n / step) * step : Math.round(n)));
    el.value = String(v);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      id={id}
      key={value}
      type="number"
      className="input mono"
      style={{ width }}
      defaultValue={value}
      min={min}
      max={max}
      step={step}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget);
        }
      }}
    />
  );
}
