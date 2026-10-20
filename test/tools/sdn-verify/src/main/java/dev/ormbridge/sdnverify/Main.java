package dev.ormbridge.sdnverify;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import org.neo4j.driver.AuthTokens;
import org.neo4j.driver.Driver;
import org.neo4j.driver.GraphDatabase;
import org.springframework.data.mapping.PersistentProperty;
import org.springframework.data.neo4j.core.Neo4jClient;
import org.springframework.data.neo4j.core.Neo4jTemplate;
import org.springframework.data.neo4j.core.mapping.GraphPropertyDescription;
import org.springframework.data.neo4j.core.mapping.IdDescription;
import org.springframework.data.neo4j.core.mapping.Neo4jMappingContext;
import org.springframework.data.neo4j.core.mapping.NodeDescription;
import org.springframework.data.neo4j.core.mapping.RelationshipDescription;
import org.springframework.data.neo4j.core.transaction.Neo4jTransactionManager;
import org.springframework.data.neo4j.core.schema.Node;
import org.springframework.data.neo4j.core.schema.RelationshipProperties;

/**
 * Loads a directory of Java classes written by {@code --to sdn} with the real Spring Data Neo4j 7.
 *
 * <p>Usage: {@code Main [--live] <name>=<directory> ...}. Every directory is compiled with the JDK compiler (every
 * lint warning is an error), a {@link Neo4jMappingContext} is built for the {@code @Node} and
 * {@code @RelationshipProperties} classes, and what it resolves (labels, identifier, graph property names,
 * relationships with type, direction, target and relationship properties class) is printed as JSON, keyed by the
 * group name. A directory that does not compile or map is printed as {@code {"__error": "..."}}.
 *
 * <p>With {@code --live} (and {@code SDN_BOLT_URL}, {@code SDN_USER}, {@code SDN_PASSWORD}) the tool also saves a
 * node graph through {@link Neo4jTemplate}, reads it back and prints the checks under {@code __live}, for the groups
 * named {@code blog} and {@code joins}.
 */
public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    Map<String, Object> output = new LinkedHashMap<>();
    boolean live = false;
    for (String argument : args) {
      if (argument.equals("--live")) {
        live = true;
        continue;
      }
      int equals = argument.indexOf('=');
      String name = argument.substring(0, equals);
      Path directory = Path.of(argument.substring(equals + 1));
      try {
        output.put(name, load(name, directory, live));
      } catch (Throwable error) {
        Map<String, Object> failure = new LinkedHashMap<>();
        StringBuilder text = new StringBuilder(String.valueOf(error));
        for (StackTraceElement frame : error.getStackTrace()) {
          if (text.length() > 1500) {
            break;
          }
          if (frame.getClassName().startsWith("dev.ormbridge") || text.length() < 300) {
            text.append("\n  at ").append(frame);
          }
        }
        failure.put("__error", text.toString());
        output.put(name, failure);
      }
    }
    System.out.println(new ObjectMapper().writeValueAsString(output));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Compile
  // -------------------------------------------------------------------------------------------------------------

  private static Path compile(Path directory) throws IOException {
    List<File> sources;
    try (Stream<Path> walk = Files.walk(directory)) {
      sources =
          walk.filter(path -> path.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
    }
    if (sources.isEmpty()) {
      throw new IOException("no Java files in " + directory);
    }
    Path classes = Files.createTempDirectory("sdn-classes");
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    StringBuilder diagnostics = new StringBuilder();
    try (StandardJavaFileManager manager = compiler.getStandardFileManager(null, null, null)) {
      Iterable<? extends JavaFileObject> units = manager.getJavaFileObjectsFromFiles(sources);
      List<String> options =
          List.of("-d", classes.toString(), "-Xlint:all", "-Werror", "-proc:none", "--release", "17");
      boolean ok =
          compiler
              .getTask(
                  new java.io.Writer() {
                    @Override
                    public void write(char[] buffer, int offset, int length) {
                      diagnostics.append(buffer, offset, length);
                    }

                    @Override
                    public void flush() {}

                    @Override
                    public void close() {}
                  },
                  manager,
                  null,
                  options,
                  null,
                  units)
              .call();
      if (!ok) {
        throw new IOException("compilation failed:\n" + diagnostics);
      }
    }
    return classes;
  }

  private static List<Class<?>> loadClasses(Path classes, ClassLoader loader) throws Exception {
    List<Class<?>> found = new ArrayList<>();
    try (Stream<Path> walk = Files.walk(classes)) {
      for (Path file : walk.filter(path -> path.toString().endsWith(".class")).sorted().toList()) {
        String relative = classes.relativize(file).toString();
        String name = relative.substring(0, relative.length() - ".class".length()).replace(File.separatorChar, '.');
        found.add(Class.forName(name, true, loader));
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------------------------------------------

  private static Object load(String name, Path directory, boolean live) throws Exception {
    Path classes = compile(directory);
    try (URLClassLoader loader =
        new URLClassLoader(new URL[] {classes.toUri().toURL()}, Main.class.getClassLoader())) {
      Thread.currentThread().setContextClassLoader(loader);
      List<Class<?>> all = loadClasses(classes, loader);
      Set<Class<?>> entities = new LinkedHashSet<>();
      for (Class<?> type : all) {
        if (type.isAnnotationPresent(Node.class) || type.isAnnotationPresent(RelationshipProperties.class)) {
          entities.add(type);
        }
      }
      Neo4jMappingContext context = new Neo4jMappingContext();
      context.setInitialEntitySet(entities);
      context.afterPropertiesSet();

      Map<String, Object> result = new LinkedHashMap<>();
      Map<String, Object> nodes = new LinkedHashMap<>();
      Map<String, Object> properties = new LinkedHashMap<>();
      for (Class<?> type : entities) {
        if (type.isAnnotationPresent(Node.class)) {
          nodes.put(type.getSimpleName(), describeNode(context, type));
        } else {
          properties.put(type.getSimpleName(), describeRelationshipProperties(context, type));
        }
      }
      result.put("nodes", nodes);
      result.put("relationshipProperties", properties);
      result.put("classes", all.stream().map(Class::getSimpleName).sorted().collect(Collectors.toList()));
      if (live && System.getenv("SDN_BOLT_URL") != null) {
        result.put("__live", Live.run(name, context, loader));
      }
      return result;
    }
  }

  private static Map<String, Object> describeNode(Neo4jMappingContext context, Class<?> type) {
    org.springframework.data.neo4j.core.mapping.Neo4jPersistentEntity<?> entity = context.getRequiredPersistentEntity(type);
    Map<String, Object> node = new LinkedHashMap<>();
    node.put("label", entity.getPrimaryLabel());
    node.put("additionalLabels", entity.getAdditionalLabels());
    IdDescription id = entity.getIdDescription();
    Map<String, Object> idInfo = new LinkedHashMap<>();
    idInfo.put("internal", id.isInternallyGeneratedId());
    idInfo.put("external", id.isExternallyGeneratedId());
    idInfo.put("assigned", id.isAssignedId());
    idInfo.put("generator", id.getIdGeneratorClass().map(Class::getSimpleName).orElse(null));
    idInfo.put("property", id.getOptionalGraphPropertyName().orElse(null));
    idInfo.put("field", entity.getIdProperty() == null ? null : entity.getIdProperty().getName());
    node.put("id", idInfo);
    Map<String, Object> graphProperties = new LinkedHashMap<>();
    for (GraphPropertyDescription property : entity.getGraphProperties()) {
      Map<String, Object> info = new LinkedHashMap<>();
      info.put("property", property.getPropertyName());
      info.put("javaType", property.getActualType().getSimpleName());
      graphProperties.put(property.getFieldName(), info);
    }
    node.put("properties", graphProperties);
    node.put("relationships", describeRelationships(entity));
    return node;
  }

  private static Map<String, Object> describeRelationshipProperties(Neo4jMappingContext context, Class<?> type) {
    org.springframework.data.neo4j.core.mapping.Neo4jPersistentEntity<?> entity = context.getRequiredPersistentEntity(type);
    Map<String, Object> described = new LinkedHashMap<>();
    Map<String, Object> graphProperties = new LinkedHashMap<>();
    for (GraphPropertyDescription property : entity.getGraphProperties()) {
      graphProperties.put(property.getFieldName(), property.getPropertyName());
    }
    described.put("properties", graphProperties);
    PersistentProperty<?> id = entity.getIdProperty();
    described.put("idField", id == null ? null : id.getName());
    return described;
  }

  private static Map<String, Object> describeRelationships(
      org.springframework.data.neo4j.core.mapping.Neo4jPersistentEntity<?> entity) {
    Map<String, Object> described = new LinkedHashMap<>();
    Collection<RelationshipDescription> relationships = entity.getRelationships();
    for (RelationshipDescription relationship : relationships) {
      Map<String, Object> info = new LinkedHashMap<>();
      info.put("type", relationship.getType());
      info.put("direction", relationship.getDirection().name());
      NodeDescription<?> target = relationship.getTarget();
      info.put("target", target.getPrimaryLabel());
      info.put("collection", entity.getPersistentProperty(relationship.getFieldName()).isCollectionLike());
      info.put(
          "propertiesClass",
          relationship.hasRelationshipProperties()
              ? relationship.getRelationshipPropertiesEntity().getUnderlyingClass().getSimpleName()
              : null);
      described.put(relationship.getFieldName(), info);
    }
    return described;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reflection helpers shared with Live
  // -------------------------------------------------------------------------------------------------------------

  static Object create(ClassLoader loader, String className) throws Exception {
    return Class.forName(className, true, loader).getDeclaredConstructor().newInstance();
  }

  static void set(Object target, String field, Object value) throws Exception {
    String setter = "set" + Character.toUpperCase(field.charAt(0)) + field.substring(1);
    for (Method method : target.getClass().getMethods()) {
      if (method.getName().equals(setter) && method.getParameterCount() == 1) {
        method.invoke(target, value);
        return;
      }
    }
    Field declared = target.getClass().getDeclaredField(field);
    declared.setAccessible(true);
    declared.set(target, value);
  }

  static Object get(Object target, String field) throws Exception {
    String getter = "get" + Character.toUpperCase(field.charAt(0)) + field.substring(1);
    return target.getClass().getMethod(getter).invoke(target);
  }

  static Neo4jTemplate template(Neo4jMappingContext context, Driver driver) {
    return new Neo4jTemplate(Neo4jClient.create(driver), context, new Neo4jTransactionManager(driver));
  }

  static Driver driver() {
    return GraphDatabase.driver(
        System.getenv("SDN_BOLT_URL"),
        AuthTokens.basic(
            System.getenv().getOrDefault("SDN_USER", "neo4j"), System.getenv().getOrDefault("SDN_PASSWORD", "neo4j")));
  }
}
