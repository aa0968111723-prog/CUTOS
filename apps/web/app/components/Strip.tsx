export interface StripItem {
  leftPct: number;
  widthPct: number;
  kind: "keep" | "speed" | "silence";
  title: string;
}

export function Strip({ items }: { items: StripItem[] }) {
  return (
    <div className="timeline" role="img" aria-label="Timeline">
      {items.map((item, i) => (
        <div
          key={i}
          className={`seg ${item.kind}`}
          style={{ left: `${item.leftPct}%`, width: `${Math.max(item.widthPct, 0.4)}%` }}
          title={item.title}
        />
      ))}
    </div>
  );
}
