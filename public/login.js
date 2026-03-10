const loginForm = document.getElementById("login-form");
const loginButton = document.getElementById("login-button");
const loginStatus = document.getElementById("login-status");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());

  loginButton.disabled = true;
  loginStatus.textContent = "驗證中。";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Login failed.");
    }

    window.location.href = "/";
  } catch (error) {
    loginStatus.textContent = error instanceof Error ? error.message : "Unknown error";
  } finally {
    loginButton.disabled = false;
  }
});
