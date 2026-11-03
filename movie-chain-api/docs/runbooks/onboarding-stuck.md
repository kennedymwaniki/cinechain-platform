# OnboardingStuck fired

A run has been provisioning for over 5 minutes. A half-created tenant is worse than none.

1. On the control plane (127.0.0.1:3001, operator token): `GET /admin/tenants/<tenant id>/status`
   shows the run's status, current step and last error.
2. Runs are resumable: a crashed worker's run is picked up on restart, and completed steps are
   not redone. After fixing the cause, `POST /admin/onboarding/<run id>/retry`. Check the
   `control.onboarding` queue for failed jobs.
3. If a step keeps failing, the run compensates its recorded resources after the final attempt.
   A fresh tenant that must be removed by hand: `DELETE /admin/tenants/<id>` (refused if it has data).
