import { useMemo } from "react";
import type { MouseEvent, ReactNode } from "react";

export type RingOption = {
  id: string;
  name: string;
  description?: string;
  assetUrl: string;
  accentColor?: string;
  thumbnail?: string;
  extra?: ReactNode;
};

type RingMenuProps = {
  options: RingOption[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export default function RingMenu({ options, selectedId, onSelect }: RingMenuProps) {
  const introCopy = useMemo(
    () =>
      "Preview rings in real time, swap styles instantly, and keep the camera feed active while you explore.",
    []
  );

  return (
    <section className="ring-selector" aria-label="Ring selection">
      <header className="ring-selector__intro">
        <h2>Virtual Ring Studio</h2>
        <p>{introCopy}</p>
      </header>

      <div className="ring-selector__grid">
        {options.map((option) => {
          const isActive = option.id === selectedId;

          const handleSelect = () => {
            if (!isActive) {
              onSelect(option.id);
            }
          };

          return (
            <div key={option.id} className={`ring-card${isActive ? " ring-card--active" : ""}`}>
              <button
                type="button"
                className="ring-card__select"
                onClick={handleSelect}
                aria-pressed={isActive}
              >
                <div className="ring-card__media">
                  {option.thumbnail ? (
                    <img src={option.thumbnail} alt={option.name} />
                  ) : (
                    <span>{option.name}</span>
                  )}
                </div>
                {option.extra}
              </button>
              <div className="ring-card__actions">
                <button
                  type="button"
                  className="ring-card__action"
                  onClick={(event: MouseEvent<HTMLButtonElement>) => event.stopPropagation()}
                  disabled={!isActive}
                  aria-label="Decrease ring size"
                >
                  –
                </button>
                <button
                  type="button"
                  className="ring-card__action ring-card__action--primary"
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onSelect(option.id);
                  }}
                  aria-label="Add this ring"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="ring-selector__footer">
        <button type="button" className="ring-selector__guide">
          View size guide
        </button>
        <div className="ring-selector__cta">
          <button type="button">Book Consultation</button>
          <button type="button">Learn More</button>
        </div>
      </footer>
    </section>
  );
}
