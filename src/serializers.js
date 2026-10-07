'use strict';

function publicUser(u) {
  if (!u) return u;
  const rest = { ...u };
  delete rest.passwordHash;
  return rest;
}

module.exports = { publicUser };