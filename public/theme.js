// Applied before the page paints so a chosen theme never flashes the other one.
'use strict';
try {
  const theme = JSON.parse(localStorage.getItem('theme'));
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* private mode */ }
