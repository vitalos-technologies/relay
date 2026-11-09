// Section icons (HC): schema icon names → lucide components.
import {
  Blocks, CalendarDays, ChartColumn, Code, CreditCard, FolderInput, Inbox, LifeBuoy, PanelsTopLeft, Plug, Radar, Rocket, ShieldCheck, Sparkles,
  SquarePen, Users, Wrench, BookOpen, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  Rocket, SquarePen, CalendarDays, ChartColumn, Users, Plug, FolderInput, Blocks, Inbox, Radar, Sparkles, CreditCard, ShieldCheck, LifeBuoy, Wrench, Code, PanelsTopLeft,
};
export const sectionIcon = (name: string): LucideIcon => ICONS[name] ?? BookOpen;
