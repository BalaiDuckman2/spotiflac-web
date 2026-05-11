import { NavLink } from 'react-router-dom';
import {
  Home,
  Search,
  Disc3,
  Download,
  Eye,
  Settings as SettingsIcon,
  Terminal,
  Boxes,
  Github,
  Info,
  Coffee,
} from 'lucide-react';

import { cn } from '@/lib/cn';

type Item = { to: string; icon: typeof Home; label: string; end?: boolean };

const topGroup: Item[] = [
  { to: '/', icon: Home, label: 'Home', end: true },
  { to: '/search', icon: Search, label: 'Search' },
];

const libraryGroup: Item[] = [
  { to: '/library', icon: Disc3, label: 'Your Library' },
  { to: '/downloads', icon: Download, label: 'Downloads' },
  { to: '/watched', icon: Eye, label: 'Watched' },
];

const settingsGroup: Item[] = [
  { to: '/settings', icon: SettingsIcon, label: 'Settings' },
  { to: '/logs', icon: Terminal, label: 'Logs' },
  { to: '/modules', icon: Boxes, label: 'Modules' },
];

export default function Sidebar() {
  return (
    <aside className="flex h-screen w-56 flex-col justify-between border-r border-gray-200 bg-white">
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-green-500 text-white">
            <span className="text-base leading-none">♪</span>
          </div>
          <span className="text-base font-semibold tracking-tight">SpotiFLAC</span>
          <span className="ml-auto rounded bg-yellow-300 px-1.5 py-0.5 text-[10px] font-semibold">
            v0.1
          </span>
        </div>

        <NavGroup items={topGroup} />
        <Divider />
        <NavGroup items={libraryGroup} />
        <Divider />
        <NavGroup items={settingsGroup} />
      </div>

      <div className="flex items-center justify-center gap-1 border-t border-gray-200 px-2 py-3 text-gray-400">
        <a
          href="https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version"
          target="_blank"
          rel="noreferrer"
          title="GitHub"
          className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Github size={14} />
        </a>
        <button
          title="About"
          className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Info size={14} />
        </button>
        <button
          title="Donate"
          className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Coffee size={14} />
        </button>
      </div>
    </aside>
  );
}

function NavGroup({ items }: { items: Item[] }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-2">
      {items.map(({ to, icon: Icon, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition',
              'hover:bg-gray-100 hover:text-gray-900',
              isActive && 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100',
            )
          }
        >
          <Icon size={16} className="flex-shrink-0" />
          <span className="truncate">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function Divider() {
  return <div className="mx-3 border-t border-gray-100" />;
}
