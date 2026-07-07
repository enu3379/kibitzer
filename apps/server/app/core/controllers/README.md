# Controllers

Controllers decide whether Kibitzer should intervene. They do not inspect raw page content.

Implemented: `StreakController` (B안, consecutive drifts) and
`AlignmentController` (A안, EWMA alignment score with hysteresis) — selectable
via settings.

Future controllers such as Page-Hinkley, CUSUM, or ADWIN must implement the
same interface so replay can compare them on identical logs.

