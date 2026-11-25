"use strict";

window.nhacPhoneVerification = {
  mount(container, factorId, onVerified) {
    const fragment = document.querySelector("#sms-verification-template").content.cloneNode(true);
    const form = fragment.querySelector("form");
    const telephone = form.elements.phone;
    const code = form.elements.code;
    const codeControls = form.querySelector("[data-sms-code]");
    const send = form.querySelector("[data-send-sms]");
    const submit = form.querySelector('button[type="submit"]');
    const status = form.querySelector("[data-sms-status]");
    const auth = window.nhacHosted;
    let challenge;
    let busy = false;
    let disposed = false;
    let cooldown;
    form.querySelector("[data-phone-field]").hidden = Boolean(factorId);
    container.replaceChildren(fragment);

    const syncControls = () => {
      telephone.disabled = busy || Boolean(factorId);
      send.disabled = busy || cooldown !== undefined;
      submit.disabled = busy;
      codeControls.hidden = !challenge;
      code.disabled = busy || !challenge;
    };

    telephone.addEventListener("input", () => {
      challenge = undefined;
      code.value = "";
      status.textContent = "";
      syncControls();
    });
    send.addEventListener("click", async () => {
      if (disposed || busy || cooldown !== undefined) return;
      const phone = telephone.value.trim().replace(/[\s().-]/g, "");
      if (!factorId && !/^\+[1-9][0-9]{7,14}$/.test(phone)) {
        status.textContent = "Informe o número completo, incluindo +55 e o DDD.";
        telephone.focus();
        return;
      }
      busy = true;
      syncControls();
      let focusCode = false;
      status.textContent = "Enviando código…";
      try {
        const nextChallenge = await auth.sendPhoneCode(phone, factorId);
        if (disposed) return;
        challenge = nextChallenge;
        code.value = "";
        send.textContent = "Reenviar em 60 s";
        cooldown = window.setTimeout(() => {
          cooldown = undefined;
          send.textContent = "Reenviar código por SMS";
          syncControls();
        }, 60000);
        status.textContent = "Código enviado. Confira suas mensagens.";
        focusCode = true;
      } catch (error) {
        if (!disposed) status.textContent = error.message;
      } finally {
        busy = false;
        if (!disposed) {
          syncControls();
          if (focusCode) code.focus();
        }
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!challenge || busy || disposed) return;
      const value = code.value;
      busy = true;
      syncControls();
      try {
        await auth.verifyPhoneCode(challenge, value);
        if (!disposed) await onVerified();
      } catch (error) {
        if (!disposed) status.textContent = error.message;
      } finally {
        busy = false;
        if (!disposed) syncControls();
      }
    });

    syncControls();
    return {
      focus: () => (factorId ? send : telephone).focus(),
      dispose() {
        disposed = true;
        window.clearTimeout(cooldown);
        form.remove();
      }
    };
  }
};
