import { Outlet } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import { ToasterProvider } from '@/components/Toaster';

export default function App() {
  return (
    <ToasterProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 overflow-x-hidden">
          <TopBar />
          <Outlet />
        </main>
      </div>
    </ToasterProvider>
  );
}
