// Same key and check as isEditingUnlocked() in index.html (keep the key in sync with GITHUB_TOKEN_STORAGE_KEY there).
const GITHUB_TOKEN_STORAGE_KEY = 'githubEditToken';

export function isAuthorized() {
  return Boolean(localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY));
}
