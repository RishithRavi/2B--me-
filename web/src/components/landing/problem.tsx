import { KeyRound, MailWarning, UserRoundX } from "lucide-react";

const STATS = [
  {
    icon: MailWarning,
    value: "$2.9B",
    label: "lost to business email compromise in 2023",
    body: "Attackers who get inside a real account look exactly like its owner to every system that only checked the login.",
  },
  {
    icon: UserRoundX,
    value: "$3.4B",
    label: "lost by Americans over 60 to cybercrime in 2023",
    body: "Tech-support scams that take over a victim's computer hand a stranger a session that is already signed in.",
  },
] as const;

/** The stakes (newGoal): two FBI IC3 figures and the gap they share. */
export function Problem() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        {STATS.map((s) => (
          <div key={s.value} className="panel relative overflow-hidden p-6">
            <s.icon className="size-5 text-trust-suspicious" />
            <div className="tnum mt-4 text-5xl font-semibold tracking-tight">{s.value}</div>
            <div className="mt-1 text-sm font-medium">{s.label}</div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        ))}
        <div className="panel flex flex-col p-6">
          <KeyRound className="size-5 text-brand" />
          <div className="mt-4 text-xl leading-snug font-semibold text-balance">Passwords and MFA check a moment. Attacks happen during the session.</div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Once a session is open, nothing asks again whether the person at the keyboard is still the one who signed in. 2bME asks every few seconds,
            quietly, and only interrupts when the answer changes.
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Source: FBI Internet Crime Complaint Center (IC3), 2023 Internet Crime Report and 2023 Elder Fraud Report.
      </p>
    </div>
  );
}
