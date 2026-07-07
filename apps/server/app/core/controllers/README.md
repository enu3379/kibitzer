# Controllers

Controllers decide whether Kibitzer should intervene. They do not inspect raw page content.

Stage 0 implements `StreakController`.

Future controllers such as EWMA, Page-Hinkley, CUSUM, or ADWIN must implement the same interface so replay can compare them on identical logs.

