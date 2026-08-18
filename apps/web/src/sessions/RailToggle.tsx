export interface RailToggleProps {
  onOpen: () => void;
}

export function RailToggle({ onOpen }: RailToggleProps): React.JSX.Element {
  return (
    <button className="rail-toggle" type="button" aria-label="Show sessions" onClick={onOpen}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          d="M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-13ZM9 3v18"
          stroke="currentColor"
          strokeWidth="1.7"
        />
      </svg>
    </button>
  );
}
