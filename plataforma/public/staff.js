"use strict";

(() => {
  if (!window.nhacHosted) return;
  const get = id => document.getElementById(id);
  const profileForm = get("staff-profile-form");
  const roleForm = get("access-level-form");
  const assignmentForm = get("access-assign-form");
  const avatar = get("staff-avatar");
  const photoInput = get("staff-photo");
  const removePhoto = get("staff-remove-photo");
  const levelsSelect = get("access-level-edit");
  const roleSelect = get("access-role");
  const profileStatus = get("staff-profile-status");
  const accessStatus = get("staff-access-status");
  const areas = roleForm.querySelectorAll('input[name="capability"]');

  let session;
  let userRole;
  let avatarUrl;
  let pendingPhoto;
  let levels = [];
  let accessBusy = false;
  let profileBusy = false;
  let photoBusy = false;
  let staffSmsFlow;

  function toggleForms() {
    get("staff-save").disabled = !session || profileBusy || photoBusy;
    photoInput.disabled = !session || profileBusy || photoBusy;
    removePhoto.disabled = photoInput.disabled;
    roleForm.querySelector('button[type="submit"]').disabled = !session || accessBusy;
    assignmentForm.querySelector('button[type="submit"]').disabled = !session || accessBusy;
  }

  async function api(path, data, requestSession) {
    const response = await window.nhacHosted.request(path, {
      signal: requestSession.signal,
      ...(data ? { method: "POST", body: JSON.stringify(data) } : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
    return result;
  }

  function showAvatar(photo, mime) {
    if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    avatarUrl = undefined;
    avatar.removeAttribute("src");
    if (photo) {
      const bytes = Uint8Array.from(atob(photo), letter => letter.charCodeAt(0));
      avatarUrl = URL.createObjectURL(new Blob([bytes], {type:mime}));
      avatar.src = avatarUrl;
    }
    avatar.hidden = !avatarUrl;
    get("staff-initials").hidden = Boolean(avatarUrl);
    removePhoto.hidden = !avatarUrl;
  }

  function showProfile(profile) {
    get("staff-name").value = profile.name;
    get("staff-phone").value = profile.phone ?? "";
    get("staff-role").textContent = profile.role;
    get("staff-email").textContent = profile.email;
    get("staff-initials").textContent = profile.name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
    showAvatar(profile.photo, profile.mime);
    pendingPhoto = undefined;
    photoInput.value = "";
  }

  async function loadProfile(current) {
    profileStatus.textContent = "Carregando perfil…";
    profileBusy = true;
    toggleForms();
    try {
      const profile = await api("/api/admin/me", undefined, current);
      if (current !== session) return;
      showProfile(profile);
      profileStatus.textContent = "";
    } catch (error) {
      if (current === session) profileStatus.textContent = error.message;
    } finally {
      if (current === session) {
        profileBusy = false;
        toggleForms();
      }
    }
  }

  async function preparePhoto(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024) {
      throw new Error("Escolha uma imagem JPEG, PNG ou WebP de até 12 MB.");
    }
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .82));
      if (!image || image.size > 180000) throw new Error("A foto ficou grande demais. Escolha uma imagem menor.");
      const bytes = new Uint8Array(await image.arrayBuffer());
      let content = "";
      for (let i = 0; i < bytes.length; i += 8192) content += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(content);
    } finally { bitmap.close(); }
  }

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    const current = session;
    if (!file || !current) return;
    photoBusy = true;
    toggleForms();
    profileStatus.textContent = "Preparando foto…";
    try {
      const photo = await preparePhoto(file);
      if (current !== session) return;
      pendingPhoto = photo;
      showAvatar(pendingPhoto, "image/jpeg");
      profileStatus.textContent = "Foto pronta. Salve o perfil para aplicar.";
    } catch (error) {
      if (current === session) {
        profileStatus.textContent = error.name === "Error" ? error.message : "Não foi possível abrir esta imagem.";
      }
    } finally {
      if (current === session) {
        photoBusy = false;
        photoInput.value = "";
        toggleForms();
      }
    }
  });

  removePhoto.addEventListener("click", () => {
    pendingPhoto = null;
    showAvatar(null);
    photoInput.focus();
    profileStatus.textContent = "Salve o perfil para remover a foto.";
  });

  profileForm.addEventListener("submit", async event => {
    event.preventDefault();
    const current = session;
    if (!current || profileBusy || photoBusy) return;
    const data = {
      name: get("staff-name").value.trim(),
      phone: get("staff-phone").value.trim()
    };
    if (pendingPhoto !== undefined) Object.assign(data, {photo:pendingPhoto, mime:"image/jpeg"});
    profileBusy = true;
    toggleForms();
    try {
      const profile = await api("/api/admin/me", data, current);
      if (current !== session) return;
      showProfile(profile);
      profileStatus.textContent = "Perfil atualizado.";
    } catch (error) {
      if (current === session) profileStatus.textContent = error.message;
    } finally {
      if (current === session) {
        profileBusy = false;
        toggleForms();
      }
    }
  });

  function editLevel() {
    const level = levels.find(item => item.id === levelsSelect.value);
    get("access-level-name").value = level?.name || "";
    for (const area of areas) area.checked = level?.permissions.includes(area.value) ?? false;
  }

  levelsSelect.addEventListener("change", editLevel);

  function showAccess({levels: available, staff}) {
    levels = available;
    const editId = levelsSelect.value;
    const assignId = roleSelect.value;
    levelsSelect.replaceChildren(new Option("Criar novo nível", ""));
    roleSelect.replaceChildren(new Option("Selecione um nível", ""), new Option("MAIN · Acesso completo", "main"), new Option("Cliente · Remover acesso ao painel", "customer"));
    for (const level of levels) {
      levelsSelect.add(new Option(level.name, level.id));
      roleSelect.add(new Option(level.name, level.id));
    }
    levelsSelect.value = levels.some(level => level.id === editId) ? editId : "";
    roleSelect.value = Array.from(roleSelect.options).some(option => option.value === assignId) ? assignId : "";
    editLevel();
    const body = get("access-team-rows");
    body.replaceChildren();
    for (const member of staff) {
      const row = element("tr");
      const cell = element("td");
      if (member.self) cell.textContent = "Sua conta";
      else {
        const edit = element("button", "Alterar acesso", "shop-add");
        edit.type = "button";
        edit.addEventListener("click", () => {
          get("access-email").value = member.email;
          roleSelect.value = member.level;
          roleSelect.focus();
        });
        cell.append(edit);
      }
      row.append(element("td", member.email), element("td", member.name), cell);
      body.append(row);
    }
  }

  async function updateAccess(current, operation, data, success) {
    if (accessBusy) return;
    accessBusy = true;
    toggleForms();
    accessStatus.textContent = data ? "Salvando acesso…" : "Carregando acessos…";
    try {
      if (data) await api(operation, data, current);
      const result = await api("/api/admin/access", undefined, current);
      if (current !== session) return;
      showAccess(result);
      if (operation === "/api/admin/access/assign") assignmentForm.reset();
      accessStatus.textContent = success;
    } catch (error) {
      if (current === session) accessStatus.textContent = error.message;
    } finally {
      if (current === session) {
        accessBusy = false;
        toggleForms();
      }
    }
  }

  roleForm.addEventListener("submit", event => {
    event.preventDefault();
    if (userRole !== "MAIN" || !session || accessBusy) return;
    const permissions = [...areas].filter(area => area.checked).map(area => area.value);
    if (!permissions.length) {
      accessStatus.textContent = "Selecione pelo menos uma área.";
      areas[0].focus();
      return;
    }
    const data = {id:levelsSelect.value, name:get("access-level-name").value.trim(), permissions};
    updateAccess(session, "/api/admin/access/levels", data, "Nível de acesso salvo.");
  });

  assignmentForm.addEventListener("submit", event => {
    event.preventDefault();
    if (userRole !== "MAIN" || !session || accessBusy) return;
    const email = get("access-email").value.trim().toLowerCase();
    const level = roleSelect.value;
    const label = roleSelect.selectedOptions[0].textContent;
    if (!window.confirm("Aplicar o acesso " + label + " para " + email + "?")) return;
    updateAccess(session, "/api/admin/access/assign", {email, level}, "Acesso atualizado.");
  });

  async function loadStaffSms(current) {
    const section = get("sms-staff");
    if (!window.nhacHosted.smsMfaEnabled) return;
    const container = get("sms-staff-form");
    try {
      const existing = await window.nhacHosted.getPhoneFactor();
      if (current !== session) return;
      section.hidden = false;
      staffSmsFlow?.dispose();
      if (existing) {
        container.textContent = "Celular verificado. O SMS será a primeira opção no próximo login.";
      } else {
        staffSmsFlow = window.nhacPhoneVerification.mount(container, null, () => loadStaffSms(current));
      }
    } catch {
      if (current === session) {
        section.hidden = false;
        container.textContent = "Não foi possível consultar sua configuração por SMS.";
      }
    }
  }

  document.addEventListener("nhac:session", event => {
    session?.abort();
    staffSmsFlow?.dispose();
    staffSmsFlow = undefined;
    get("sms-staff").hidden = true;
    get("sms-staff-form").replaceChildren();
    userRole = event.detail;
    session = ["MAIN", "STAFF"].includes(userRole) ? new AbortController() : undefined;
    profileBusy = false;
    photoBusy = false;
    accessBusy = false;
    pendingPhoto = undefined;
    profileForm.reset();
    roleForm.reset();
    assignmentForm.reset();
    get("staff-role").textContent = "—";
    get("staff-email").textContent = "—";
    get("staff-initials").textContent = "";
    showAvatar(null);
    showAccess({levels:[],staff:[]});
    profileStatus.textContent = "";
    accessStatus.textContent = "";
    toggleForms();
  });

  document.addEventListener("nhac:staff-panel", event => {
    queueMicrotask(() => {
      if (!session) return;
      if (event.detail === "my-account-panel" && !profileBusy && !photoBusy) {
        loadProfile(session);
        if (!staffSmsFlow) loadStaffSms(session);
      }
      if (event.detail === "access-panel" && userRole === "MAIN") updateAccess(session, undefined, undefined, "");
    });
  });
})();
