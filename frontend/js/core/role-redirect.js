// Old dashboard addresses (/dashboard.html, /admin-dashboard.html): send the visitor to the dashboard for their role,
// or to the login page when nobody is signed in. Kept in its own file so the Content-Security-Policy in vercel.json
// needs no script hash for these pages.
(function redirectToRoleDashboard() {
  const user = getUser();
  if (user) {
    try {
      redirectToDashboardForRole(user.role);
    } catch (error) {
      redirectToLogin();
    }
  } else {
    redirectToLogin();
  }
})();
