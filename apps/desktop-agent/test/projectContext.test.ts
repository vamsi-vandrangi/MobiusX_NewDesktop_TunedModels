import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectContext } from "../src/projectContext.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-context-test-"));
}

function find(report: Awaited<ReturnType<typeof detectProjectContext>>, category: string, name: string) {
  return report.components.find((c) => c.category === category && c.name === name);
}

test("detectProjectContext detects a Spring Boot + Postgres Maven backend", async () => {
  const dir = await tempProject();
  await writeFile(
    join(dir, "pom.xml"),
    `<project>
      <dependencies>
        <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
        <dependency><artifactId>postgresql</artifactId></dependency>
        <dependency><artifactId>junit-jupiter</artifactId></dependency>
      </dependencies>
    </project>`,
  );
  const report = await detectProjectContext(dir);
  assert.ok(find(report, "backend", "Spring Boot"));
  assert.ok(find(report, "orm", "Hibernate / Spring Data JPA"));
  assert.ok(find(report, "database", "PostgreSQL"));
  assert.ok(find(report, "testFramework", "JUnit"));
});

test("detectProjectContext detects a Gradle Kotlin DSL backend the same way as Maven", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"));
  await writeFile(
    join(dir, "backend", "build.gradle.kts"),
    `dependencies {
      implementation("org.springframework.boot:spring-boot-starter-web")
      testImplementation("org.junit.jupiter:junit-jupiter")
    }`,
  );
  const report = await detectProjectContext(dir);
  const backend = find(report, "backend", "Spring Boot");
  assert.ok(backend);
  assert.equal(backend!.location, "backend");
});

test("detectProjectContext detects an ASP.NET Core + EF Core .csproj nested one level under backend/", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend", "MyApi"), { recursive: true });
  await writeFile(
    join(dir, "backend", "MyApi", "MyApi.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk.Web">
      <ItemGroup>
        <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
        <PackageReference Include="Npgsql" Version="8.0.0" />
        <PackageReference Include="xunit" Version="2.6.0" />
      </ItemGroup>
    </Project>`,
  );
  const report = await detectProjectContext(dir);
  assert.ok(find(report, "backend", "ASP.NET Core"));
  assert.ok(find(report, "orm", "Entity Framework Core"));
  assert.ok(find(report, "database", "PostgreSQL"));
  assert.ok(find(report, "testFramework", "xUnit"));
});

test("detectProjectContext detects Drogon + Google Test from CMakeLists.txt", async () => {
  const dir = await tempProject();
  await writeFile(
    join(dir, "CMakeLists.txt"),
    `find_package(Drogon CONFIG REQUIRED)
     find_package(GTest REQUIRED)
     target_link_libraries(app PRIVATE Drogon::Drogon GTest::gtest)`,
  );
  const report = await detectProjectContext(dir);
  assert.ok(find(report, "backend", "Drogon"));
  assert.ok(find(report, "testFramework", "Google Test"));
  assert.ok(find(report, "infra", "CMake")); // from detectInfra's build-system check, not CMAKE_SIGNALS
});

test("detectProjectContext reports Make as infra for a plain Makefile project with no CMakeLists.txt", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "Makefile"), "test:\n\tgcc -o app main.c && ./app\n");
  const report = await detectProjectContext(dir);
  assert.ok(find(report, "infra", "Make"));
  assert.equal(find(report, "infra", "CMake"), undefined);
});

test("detectProjectContext leaves categories genuinely undetected alone rather than guessing", async () => {
  const dir = await tempProject();
  const report = await detectProjectContext(dir);
  assert.equal(report.components.length, 0);
  assert.deepEqual(
    [...report.unknownCategories].sort(),
    ["auth", "backend", "database", "frontend", "infra", "orm", "testFramework"].sort(),
  );
});
