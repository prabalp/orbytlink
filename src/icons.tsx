// Functional UI affordances only. App and service identity is carried by text or
// authentic assets; these small inline paths are not used as decorative tile marks.
import type { SVGProps, ReactNode } from "react";
type IconProps = SVGProps<SVGSVGElement> & { size?: number };
function Glyph({
  size = 18,
  children,
  ...props
}: IconProps & { children?: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}
export function Plus(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}
export function X(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m6 6 12 12M6 18 18 6" />
    </Glyph>
  );
}
export function Check(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m5 12 4 4L19 6" />
    </Glyph>
  );
}
export function CheckCheck(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m3 12 4 4L17 6m-4 10L23 6" />
    </Glyph>
  );
}
export function ChevronRight(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m9 5 7 7-7 7" />
    </Glyph>
  );
}
export function ChevronDown(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m5 9 7 7 7-7" />
    </Glyph>
  );
}
export function ArrowRight(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </Glyph>
  );
}
export function ArrowUpRight(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M6 18 18 6M7 6h11v11" />
    </Glyph>
  );
}
export function ArrowUp(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 20V4m-6 6 6-6 6 6" />
    </Glyph>
  );
}
export function ArrowDown(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 4v16m-6-6 6 6 6-6" />
    </Glyph>
  );
}
export function Search(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </Glyph>
  );
}
export function Copy(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect x="8" y="8" width="12" height="12" rx="1" />
      <path d="M5 16H3V3h13v2" />
    </Glyph>
  );
}
export function Download(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
    </Glyph>
  );
}
export function Trash2(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </Glyph>
  );
}
export function Menu(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Glyph>
  );
}
export function Ellipsis(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Glyph>
  );
}
export function Play(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m8 5 11 7-11 7V5Z" />
    </Glyph>
  );
}
export function LoaderCircle(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M20 12a8 8 0 1 1-8-8" />
    </Glyph>
  );
}
export function LockKeyhole(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect x="5" y="10" width="14" height="11" rx="1" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </Glyph>
  );
}
export function CircleHelp(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 1 1 5 2l-2 2m0 3h.01" />
    </Glyph>
  );
}
export function ShieldCheck(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </Glyph>
  );
}
export function FileText(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M6 3h8l4 4v14H6V3Zm7 0v5h5M9 12h6m-6 4h6" />
    </Glyph>
  );
}
export function Code2(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 3l-4 18" />
    </Glyph>
  );
}
export function Clock3(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5h4" />
    </Glyph>
  );
}
export function Link2(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="m10 14 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" />
    </Glyph>
  );
}
// These components mark existing functional contexts, not an integration's identity.
export const Activity = Clock3,
  Bot = Code2,
  CircleDollarSign = CircleHelp,
  Folder = FileText,
  LayoutDashboard = Menu,
  Settings2 = Menu,
  Terminal = Code2,
  Zap = ArrowRight;
export function MessageSquare(p: IconProps) {
  return <Glyph {...p}><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" /></Glyph>;
}
export function PanelLeft(p: IconProps) {
  return <Glyph {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18" /></Glyph>;
}
export function SquarePen(p: IconProps) {
  return <Glyph {...p}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l1-5L19 1l5 5-8 8z" transform="translate(-1 1) scale(.95)" /></Glyph>;
}
export function Sun(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Glyph>
  );
}
export function Moon(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Glyph>
  );
}
export function Eye(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  );
}
export function EyeOff(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.5 3.5 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49M14.08 14.16a3 3 0 0 1-4.24-4.24M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14M2 2l20 20" />
    </Glyph>
  );
}
export function Users(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Glyph>
  );
}
export function LayoutGrid(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </Glyph>
  );
}
export function KeyRound(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </Glyph>
  );
}
export function UserRound(p: IconProps) {
  return (
    <Glyph {...p}>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </Glyph>
  );
}
export function BookOpen(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </Glyph>
  );
}
export function Workflow(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </Glyph>
  );
}
