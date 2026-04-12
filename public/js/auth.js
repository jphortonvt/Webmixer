// Frontend auth: check login status and display user info
const Auth = (() => {
  let currentUser = null;

  async function init() {
    try {
      const res = await fetch('/auth/me');
      if (res.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      currentUser = await res.json();

      // Show user info in header
      const userInfo = document.getElementById('user-info');
      const userAvatar = document.getElementById('user-avatar');
      const userName = document.getElementById('user-name');
      const adminLink = document.getElementById('admin-link');

      userName.textContent = currentUser.name || currentUser.email;
      if (currentUser.picture) {
        userAvatar.src = currentUser.picture;
      } else {
        userAvatar.style.display = 'none';
      }
      if (currentUser.is_admin) {
        adminLink.classList.remove('hidden');
      }
      userInfo.classList.remove('hidden');

      return currentUser;
    } catch (err) {
      console.error('Auth check failed:', err);
      return null;
    }
  }

  function getUser() {
    return currentUser;
  }

  return { init, getUser };
})();
