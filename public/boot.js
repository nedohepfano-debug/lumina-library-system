/*
 * Boot loader. Styles come from the pre-built /css/app.css (Tailwind CSS, see scripts/build-css.mjs),
 * so the app needs no internet connection and no third-party scripts at runtime.
 */
import('/js/app.js').catch(function (err) {
  console.error(err);
  document.getElementById('app').innerHTML =
    '<p style="padding:2rem;text-align:center;color:#b91c1c">Lumina Library failed to start. Please reload the page.</p>';
});
