package dev.ormbridge.jpaverify;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import org.hibernate.SessionFactory;
import org.hibernate.boot.Metadata;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistry;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

/**
 * Loads a directory of Java entity classes with the real Hibernate ORM and prints the schema it creates.
 *
 * <p>Usage: {@code Main <name>=<directory> ...}. For every directory the sources are compiled with the JDK
 * compiler (Lombok runs as an annotation processor), every class annotated with {@code @Entity},
 * {@code @MappedSuperclass} or {@code @Embeddable} is registered, and Hibernate creates the schema in an
 * in-memory H2 database ({@code hbm2ddl.auto=create}, identifiers quoted so that names keep their case). What
 * JDBC metadata reports (tables, columns, nullability, primary keys, indexes, foreign keys) is printed as JSON,
 * keyed by name; a directory Hibernate rejects is printed as {@code {"__error": "..."}}.
 */
public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    Map<String, Object> output = new LinkedHashMap<>();
    for (String argument : args) {
      int split = argument.indexOf('=');
      String name = argument.substring(0, split);
      Path directory = Path.of(argument.substring(split + 1));
      try {
        output.put(name, load(name, directory));
      } catch (Throwable thrown) {
        Map<String, Object> error = new LinkedHashMap<>();
        Throwable root = thrown;
        StringBuilder message = new StringBuilder(String.valueOf(thrown));
        while (root.getCause() != null && root.getCause() != root) {
          root = root.getCause();
          message.append(" <- ").append(root);
        }
        error.put("__error", message.toString());
        output.put(name, error);
      }
    }
    System.out.println(new ObjectMapper().writeValueAsString(output));
  }

  private static Map<String, Object> load(String name, Path directory) throws Exception {
    Path classes = Files.createTempDirectory("jpa-verify-" + name);
    try {
      compile(directory, classes);
      try (URLClassLoader loader =
          new URLClassLoader(
              new URL[] {classes.toUri().toURL()}, Main.class.getClassLoader())) {
        List<Class<?>> entities = new ArrayList<>();
        try (Stream<Path> files = Files.walk(classes)) {
          for (Path file : files.filter(p -> p.toString().endsWith(".class")).sorted().toList()) {
            String relative = classes.relativize(file).toString();
            String className =
                relative.substring(0, relative.length() - ".class".length()).replace(File.separatorChar, '.');
            Class<?> type = Class.forName(className, false, loader);
            if (isMapped(type)) {
              entities.add(type);
            }
          }
        }
        Thread.currentThread().setContextClassLoader(loader);
        return create(name, entities);
      }
    } finally {
      try (Stream<Path> files = Files.walk(classes)) {
        files.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
      }
    }
  }

  private static boolean isMapped(Class<?> type) {
    for (java.lang.annotation.Annotation annotation : type.getDeclaredAnnotations()) {
      String simple = annotation.annotationType().getSimpleName();
      if (annotation.annotationType().getName().startsWith("jakarta.persistence.")
          && (simple.equals("Entity")
              || simple.equals("MappedSuperclass")
              || simple.equals("Embeddable"))) {
        return true;
      }
    }
    return false;
  }

  private static void compile(Path directory, Path output) throws IOException {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    List<File> sources;
    try (Stream<Path> files = Files.walk(directory)) {
      sources =
          files.filter(p -> p.toString().endsWith(".java")).sorted().map(Path::toFile).collect(Collectors.toList());
    }
    try (StandardJavaFileManager manager = compiler.getStandardFileManager(null, null, null)) {
      Iterable<? extends JavaFileObject> units = manager.getJavaFileObjectsFromFiles(sources);
      String classPath = System.getProperty("java.class.path");
      List<String> options =
          List.of(
              "-d", output.toString(),
              "-classpath", classPath,
              "-processorpath", classPath,
              "-parameters",
              "--release", "17",
              "-Xlint:-options");
      java.io.StringWriter log = new java.io.StringWriter();
      boolean success = compiler.getTask(log, manager, null, options, null, units).call();
      if (!success) {
        throw new IOException("compilation failed:\n" + log);
      }
    }
  }

  private static Map<String, Object> create(String name, List<Class<?>> entities) throws SQLException {
    String url = "jdbc:h2:mem:" + name + ";DB_CLOSE_DELAY=-1";
    StandardServiceRegistry registry =
        new StandardServiceRegistryBuilder()
            .applySetting("hibernate.connection.url", url)
            .applySetting("hibernate.connection.driver_class", "org.h2.Driver")
            .applySetting("hibernate.hbm2ddl.auto", "create")
            .applySetting("hibernate.globally_quoted_identifiers", "true")
            .applySetting("hibernate.globally_quoted_identifiers_skip_column_definitions", "true")
            .applySetting("hibernate.show_sql", "false")
            .build();
    try {
      MetadataSources sources = new MetadataSources(registry);
      for (Class<?> entity : entities) {
        sources.addAnnotatedClass(entity);
      }
      Metadata metadata = sources.buildMetadata();
      try (SessionFactory factory = metadata.buildSessionFactory();
          Connection connection = DriverManager.getConnection(url)) {
        Map<String, Object> schema = introspect(connection);
        // Hibernate only logs a DDL statement that fails, so check that every table it maps was created.
        @SuppressWarnings("unchecked")
        Map<String, Object> created = (Map<String, Object>) schema.get("tables");
        for (org.hibernate.mapping.Table table : metadata.collectTableMappings()) {
          if (table.isPhysicalTable() && !created.containsKey(table.getName())) {
            throw new IllegalStateException(
                "Hibernate did not create the table " + table.getName() + " (see the DDL errors in the log)");
          }
        }
        return schema;
      }
    } finally {
      StandardServiceRegistryBuilder.destroy(registry);
    }
  }

  private static String rule(int code) {
    switch (code) {
      case DatabaseMetaData.importedKeyCascade:
        return "CASCADE";
      case DatabaseMetaData.importedKeySetNull:
        return "SET NULL";
      case DatabaseMetaData.importedKeySetDefault:
        return "SET DEFAULT";
      case DatabaseMetaData.importedKeyRestrict:
        return "RESTRICT";
      default:
        return "NO ACTION";
    }
  }

  private static Map<String, Object> introspect(Connection connection) throws SQLException {
    DatabaseMetaData meta = connection.getMetaData();
    Map<String, Object> tables = new LinkedHashMap<>();
    List<String> names = new ArrayList<>();
    try (ResultSet rows = meta.getTables(null, "PUBLIC", "%", new String[] {"TABLE"})) {
      while (rows.next()) {
        names.add(rows.getString("TABLE_NAME"));
      }
    }
    names.sort(String::compareTo);
    for (String table : names) {
      Map<String, Object> entry = new LinkedHashMap<>();
      List<Map<String, Object>> columns = new ArrayList<>();
      try (ResultSet rows = meta.getColumns(null, "PUBLIC", table, "%")) {
        while (rows.next()) {
          Map<String, Object> column = new LinkedHashMap<>();
          column.put("name", rows.getString("COLUMN_NAME"));
          column.put("type", rows.getString("TYPE_NAME"));
          column.put("allowNull", rows.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
          column.put("size", rows.getInt("COLUMN_SIZE"));
          column.put("default", rows.getString("COLUMN_DEF"));
          columns.add(column);
        }
      }
      entry.put("columns", columns);

      Map<Short, String> keyColumns = new java.util.TreeMap<>();
      try (ResultSet rows = meta.getPrimaryKeys(null, "PUBLIC", table)) {
        while (rows.next()) {
          keyColumns.put(rows.getShort("KEY_SEQ"), rows.getString("COLUMN_NAME"));
        }
      }
      entry.put("primaryKey", new ArrayList<>(keyColumns.values()));

      Map<String, Map<String, Object>> indexes = new LinkedHashMap<>();
      try (ResultSet rows = meta.getIndexInfo(null, "PUBLIC", table, false, false)) {
        while (rows.next()) {
          String indexName = rows.getString("INDEX_NAME");
          if (indexName == null) {
            continue;
          }
          Map<String, Object> index = indexes.get(indexName);
          if (index == null) {
            index = new LinkedHashMap<>();
            index.put("name", indexName);
            index.put("unique", !rows.getBoolean("NON_UNIQUE"));
            index.put("columns", new ArrayList<String>());
            indexes.put(indexName, index);
          }
          @SuppressWarnings("unchecked")
          List<String> indexColumns = (List<String>) index.get("columns");
          indexColumns.add(rows.getString("COLUMN_NAME"));
        }
      }
      entry.put("indexes", new ArrayList<>(indexes.values()));

      Map<String, Map<String, Object>> foreignKeys = new LinkedHashMap<>();
      try (ResultSet rows = meta.getImportedKeys(null, "PUBLIC", table)) {
        while (rows.next()) {
          String keyName = rows.getString("FK_NAME");
          Map<String, Object> key = foreignKeys.get(keyName);
          if (key == null) {
            key = new LinkedHashMap<>();
            key.put("name", keyName);
            key.put("table", rows.getString("PKTABLE_NAME"));
            key.put("from", new ArrayList<String>());
            key.put("to", new ArrayList<String>());
            key.put("onDelete", rule(rows.getInt("DELETE_RULE")));
            key.put("onUpdate", rule(rows.getInt("UPDATE_RULE")));
            foreignKeys.put(keyName, key);
          }
          @SuppressWarnings("unchecked")
          List<String> from = (List<String>) key.get("from");
          @SuppressWarnings("unchecked")
          List<String> to = (List<String>) key.get("to");
          from.add(rows.getString("FKCOLUMN_NAME"));
          to.add(rows.getString("PKCOLUMN_NAME"));
        }
      }
      entry.put("foreignKeys", new ArrayList<>(foreignKeys.values()));
      tables.put(table, entry);
    }
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("tables", tables);
    return result;
  }
}
