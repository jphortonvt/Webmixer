// Comments system: threaded, time-stamped comments with seek bar markers
const Comments = (() => {
  let currentSessionId = null;
  let comments = [];

  const panel = document.getElementById('comments-panel');
  const list = document.getElementById('comments-list');
  const input = document.getElementById('comment-input');
  const btnPost = document.getElementById('btn-post-comment');
  const timeBadge = document.getElementById('comment-time-badge');
  const markersContainer = document.getElementById('comment-markers');

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function timeAgo(dateStr) {
    const now = new Date();
    const then = new Date(dateStr + 'Z'); // SQLite stores UTC
    const diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function init() {
    btnPost.addEventListener('click', postComment);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') postComment();
    });

    // Update time badge with current playback position
    setInterval(() => {
      if (Mixer.getIsPlaying() || Mixer.getCurrentTime() > 0) {
        timeBadge.textContent = formatTime(Mixer.getCurrentTime());
      }
    }, 200);
  }

  async function loadComments(sessionId) {
    currentSessionId = sessionId;
    if (!sessionId) {
      panel.classList.add('hidden');
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/comments`);
      comments = await res.json();
      renderComments();
      renderMarkers();
      panel.classList.remove('hidden');
    } catch (err) {
      console.error('Failed to load comments:', err);
    }
  }

  async function postComment(parentId) {
    const body = typeof parentId === 'object' ? input.value.trim() : null;
    let inputEl, commentBody;

    if (typeof parentId === 'number') {
      // Reply
      inputEl = document.querySelector(`.reply-input[data-parent="${parentId}"]`);
      commentBody = inputEl ? inputEl.value.trim() : '';
    } else {
      // Top-level
      parentId = null;
      inputEl = input;
      commentBody = input.value.trim();
    }

    if (!commentBody || !currentSessionId) return;

    const timestamp = Mixer.getCurrentTime();

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp_seconds: timestamp,
          body: commentBody,
          parent_id: parentId
        })
      });

      if (res.ok) {
        inputEl.value = '';
        // Close reply box if it was a reply
        if (parentId) {
          const replyBox = document.querySelector(`.reply-box[data-parent="${parentId}"]`);
          if (replyBox) replyBox.remove();
        }
        await loadComments(currentSessionId);
      }
    } catch (err) {
      console.error('Failed to post comment:', err);
    }
  }

  function renderComments() {
    list.innerHTML = '';
    const user = Auth.getUser();

    if (comments.length === 0) {
      list.innerHTML = '<div class="no-comments">No comments yet. Be the first!</div>';
      return;
    }

    comments.forEach(c => {
      const el = createCommentEl(c, user, false);
      list.appendChild(el);
    });
  }

  function createCommentEl(comment, user, isReply) {
    const div = document.createElement('div');
    div.className = isReply ? 'comment reply' : 'comment';
    div.dataset.id = comment.id;

    const canDelete = user && (user.id === comment.user_id || user.is_admin);
    const avatarHtml = comment.user_picture
      ? `<img class="comment-avatar" src="${comment.user_picture}" referrerpolicy="no-referrer">`
      : `<div class="comment-avatar comment-avatar-placeholder">${(comment.user_name || comment.user_email || '?')[0].toUpperCase()}</div>`;

    div.innerHTML = `
      <div class="comment-header">
        ${avatarHtml}
        <span class="comment-author">${escapeHtml(comment.user_name || comment.user_email)}</span>
        <span class="comment-timestamp" data-time="${comment.timestamp_seconds}">@ ${formatTime(comment.timestamp_seconds)}</span>
        <span class="comment-age">${timeAgo(comment.created_at)}</span>
      </div>
      <div class="comment-body">${escapeHtml(comment.body)}</div>
      <div class="comment-actions">
        ${!isReply ? '<button class="btn-reply">Reply</button>' : ''}
        ${canDelete ? '<button class="btn-delete-comment" data-id="' + comment.id + '">Delete</button>' : ''}
      </div>
    `;

    // Click timestamp to seek
    const tsEl = div.querySelector('.comment-timestamp');
    tsEl.style.cursor = 'pointer';
    tsEl.addEventListener('click', () => {
      Mixer.seekTo(comment.timestamp_seconds, true);
    });

    // Reply button
    const replyBtn = div.querySelector('.btn-reply');
    if (replyBtn) {
      replyBtn.addEventListener('click', () => {
        // Remove any existing reply boxes
        document.querySelectorAll('.reply-box').forEach(b => b.remove());

        const replyBox = document.createElement('div');
        replyBox.className = 'reply-box';
        replyBox.dataset.parent = comment.id;
        replyBox.innerHTML = `
          <input type="text" class="reply-input" data-parent="${comment.id}" placeholder="Write a reply...">
          <button class="btn-send-reply" data-parent="${comment.id}">Send</button>
        `;
        div.appendChild(replyBox);

        const replyInput = replyBox.querySelector('.reply-input');
        replyInput.focus();
        replyInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') postComment(comment.id);
        });
        replyBox.querySelector('.btn-send-reply').addEventListener('click', () => {
          postComment(comment.id);
        });
      });
    }

    // Delete button
    const deleteBtn = div.querySelector('.btn-delete-comment');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this comment?')) return;
        try {
          await fetch(`/api/comments/${comment.id}`, { method: 'DELETE' });
          await loadComments(currentSessionId);
        } catch (err) {
          console.error('Failed to delete:', err);
        }
      });
    }

    // Render replies
    if (comment.replies && comment.replies.length > 0) {
      const repliesDiv = document.createElement('div');
      repliesDiv.className = 'replies';
      comment.replies.forEach(r => {
        repliesDiv.appendChild(createCommentEl(r, user, true));
      });
      div.appendChild(repliesDiv);
    }

    return div;
  }

  function renderMarkers() {
    markersContainer.innerHTML = '';
    const duration = Mixer.getDuration();
    if (duration <= 0) return;

    comments.forEach(c => {
      const pct = (c.timestamp_seconds / duration) * 100;
      const marker = document.createElement('div');
      marker.className = 'comment-marker';
      marker.style.left = pct + '%';
      marker.title = `${formatTime(c.timestamp_seconds)} - ${c.user_name || c.user_email}: ${c.body.substring(0, 50)}`;
      marker.addEventListener('click', () => {
        Mixer.seekTo(c.timestamp_seconds, true);
        // Scroll to comment in list
        const commentEl = list.querySelector(`.comment[data-id="${c.id}"]`);
        if (commentEl) commentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      markersContainer.appendChild(marker);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init, loadComments };
})();
