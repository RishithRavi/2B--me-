// Server-safe (no React): imported by the root layout.
export const THEME_KEY = "2bme:theme";

/** Inline <head> script: apply the stored theme before paint (no flash). Dark is the default. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'){var e=document.documentElement;e.classList.remove('dark');e.classList.add('light');}}catch(e){}})();`;
