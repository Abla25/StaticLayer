(function () {
  var burger = document.getElementById('nav-burger');
  var mobile = document.getElementById('mobile-nav');
  if (!burger || !mobile) return;
  burger.addEventListener('click', function () {
    var open = mobile.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  });
})();
