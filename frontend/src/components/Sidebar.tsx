import { NavLink } from 'react-router-dom';
import { Home, History as HistoryIcon, Settings as SettingsIcon, Terminal, Boxes, Github, Info, Coffee } from 'lucide-react';

import { cn } from '@/lib/cn';

const items = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/history', icon: HistoryIcon, label: 'History' },
  { to: '/settings', icon: SettingsIcon, label: 'Settings' },
  { to: '/logs', icon: Terminal, label: 'Logs' },
  { to: '/modules', icon: Boxes, label: 'Modules' },
];

export default function Sidebar() {
  return (
    <aside className="flex h-screen w-14 flex-col items-center justify-between border-r border-gray-200 bg-white py-4">
      <nav className="flex flex-col gap-1">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={label}
            className={({ isActive }) =>
              cn(
                'flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100',
                isActive && 'bg-yellow-100 text-yellow-700',
              )
            }
          >
            <Icon size={18} />
          </NavLink>
        ))}
      </nav>
      <div className="flex flex-col gap-1 text-gray-400">
        <a
          href="https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version"
          target="_blank"
          rel="noreferrer"
          title="GitHub"
          className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Github size={16} />
        </a>
        <button
          title="About"
          className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Info size={16} />
        </button>
        <button
          title="Donate"
          className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-gray-100"
        >
          <Coffee size={16} />
        </button>
      </div>
    </aside>
  );
}
