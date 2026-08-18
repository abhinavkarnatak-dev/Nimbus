import type { ReactNode } from 'react';

export type SkeletonShape = 'text' | 'line' | 'title' | 'block' | 'button' | 'pill';

export interface SkeletonProps {
  shape?: SkeletonShape;
  width?: string;
  height?: string;
}

export function Skeleton({ shape = 'text', width, height }: SkeletonProps): React.JSX.Element {
  const style: React.CSSProperties = {};

  if (width !== undefined) {
    style.width = width;
  }

  if (height !== undefined) {
    style.height = height;
  }

  return (
    <span
      className={`skeleton skeleton--${shape}`}
      style={Object.keys(style).length === 0 ? undefined : style}
      aria-hidden="true"
    />
  );
}

export interface LoadingProps {
  what: string;
  children: ReactNode;
}

export function Loading({ what, children }: LoadingProps): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{what}</span>
      {children}
    </div>
  );
}

export function SignInSkeleton(): React.JSX.Element {
  return (
    <div className="container">
      <section className="signin">
        <div className="signin__card">
          <Loading what="Checking who you are.">
            <div className="skeleton-stack">
              <Skeleton shape="pill" width="4rem" />
              <Skeleton shape="title" width="72%" />
              <Skeleton shape="text" width="90%" />
              <Skeleton shape="block" height="4.75rem" />
              <Skeleton shape="button" />
              <Skeleton shape="text" width="40%" />
              <Skeleton shape="button" />
            </div>
          </Loading>
        </div>
      </section>
    </div>
  );
}

export function ConnectSkeleton({
  what = 'Checking what GitHub has granted.',
}: {
  what?: string;
}): React.JSX.Element {
  return (
    <div className="container">
      <section className="connect">
        <div className="connect__card">
          <Loading what={what}>
            <div className="skeleton-stack">
              <Skeleton shape="pill" width="5rem" />
              <Skeleton shape="title" width="60%" />
              <Skeleton shape="text" width="100%" />
              <Skeleton shape="text" width="82%" />
              <Skeleton shape="block" height="11rem" />
              <div className="skeleton-row">
                <Skeleton shape="button" width="10rem" />
                <Skeleton shape="button" width="8rem" />
              </div>
            </div>
          </Loading>
        </div>
      </section>
    </div>
  );
}

export function HeroSkeleton(): React.JSX.Element {
  return (
    <div className="container container--wide">
      <section className="hero">
        <Loading what="Loading Nimbus.">
          <div className="skeleton-stack">
            <Skeleton shape="pill" width="9rem" />
            <Skeleton shape="title" height="3rem" width="94%" />
            <Skeleton shape="title" height="3rem" width="70%" />
            <Skeleton shape="text" width="88%" />
            <Skeleton shape="text" width="76%" />
            <div className="skeleton-row">
              <Skeleton shape="button" width="11rem" />
              <Skeleton shape="button" width="10rem" />
            </div>
          </div>
        </Loading>

        <Skeleton shape="block" height="20rem" />
      </section>
    </div>
  );
}

export function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="dash">
      <aside className="rail">
        <Skeleton shape="button" />
        <div className="skeleton-stack">
          <Skeleton shape="text" width="5rem" />
          <Skeleton shape="block" height="3.5rem" />
          <Skeleton shape="block" height="3.5rem" />
          <Skeleton shape="block" height="3.5rem" />
        </div>
      </aside>

      <div className="dash__main">
        <div className="dash-skeleton">
          <Loading what="Loading your sessions.">
            <div className="dash-skeleton__head">
              <Skeleton shape="pill" width="5rem" />
              <Skeleton shape="title" width="20rem" />
              <Skeleton shape="text" width="80%" />
            </div>
          </Loading>

          <div className="dash-skeleton__composer">
            <Skeleton shape="line" width="42%" />
            <Skeleton shape="text" width="78%" />
            <Skeleton shape="text" width="64%" />
            <div className="dash-skeleton__foot">
              <Skeleton shape="pill" width="8rem" />
              <Skeleton shape="button" width="5rem" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
