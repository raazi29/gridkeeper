import { memo, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

type Variant = "default" | "primary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "default", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <span className="btn-icon">{icon}</span>}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label; also the tooltip unless `title` is given. */
  label: string;
  active?: boolean;
  size?: "sm" | "md";
  ref?: Ref<HTMLButtonElement>;
}

export const IconButton = memo(function IconButton({ label, active, size = "md", className, title, children, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={title ?? label}
      className={`icon-btn icon-btn-${size}${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});
