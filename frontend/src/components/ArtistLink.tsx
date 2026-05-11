import { Link } from 'react-router-dom';

import { cn } from '@/lib/cn';

type Props = {
  artistId: string | null | undefined;
  name: string;
  className?: string;
  title?: string;
};

export default function ArtistLink({ artistId, name, className, title }: Props) {
  if (!artistId) {
    return (
      <span className={className} title={title}>
        {name}
      </span>
    );
  }
  return (
    <Link
      to={`/artist/${artistId}`}
      title={title ?? name}
      className={cn('hover:underline focus:underline focus:outline-none', className)}
    >
      {name}
    </Link>
  );
}
