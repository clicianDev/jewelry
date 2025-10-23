import type { ReactNode } from "react";

export type RingOption = {
  id: string;
  name: string;
  description?: string;
  assetUrl: string;
  accentColor?: string;
  extra?: ReactNode;
};

type RingMenuProps = {
  options: RingOption[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export default function RingMenu({ options, selectedId, onSelect }: RingMenuProps) {
  return (
    <aside className="ring-menu" aria-label="Ring selection">
      <header className="ring-menu__header">
        <h2 className="ring-menu__title">Choose Your Ring</h2>
        <p className="ring-menu__subtitle">Swap styles instantly to see how each band looks on your hand.</p>
      </header>
      <div role="list" className="ring-menu__options">
        {options.map((option) => {
          const isActive = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              role="listitem"
              className={`ring-menu__option${isActive ? " ring-menu__option--active" : ""}`}
              onClick={() => onSelect(option.id)}
            >
              <span className="ring-menu__option-indicator" aria-hidden>
                <span style={{ background: option.accentColor ?? "#facc15" }} />
              </span>
              <span className="ring-menu__option-content">
                <span className="ring-menu__option-name">{option.name}</span>
                {option.description && (
                  <span className="ring-menu__option-description">{option.description}</span>
                )}
                {option.extra}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
