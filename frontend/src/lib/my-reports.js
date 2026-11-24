// «Mis reportes»: como los vecinos no inician sesión, este navegador recuerda los reportes que creó
// junto con un token secreto que permite borrarlos. Los datos de contacto también quedan solo aquí.
const KEY = 'afm-my-reports';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** [{ id, deleteToken, contact, createdAt }] */
export const myReports = () => read();
export const isMine = (id) => read().some((r) => r.id === id);
export const remember = (entry) => write([...read().filter((r) => r.id !== entry.id), entry]);
export const forget = (id) => write(read().filter((r) => r.id !== id));
export const tokenFor = (id) => read().find((r) => r.id === id)?.deleteToken;
