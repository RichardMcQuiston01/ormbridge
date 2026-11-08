package dev.ormbridge.jpaverify;

import java.lang.annotation.Annotation;
import java.lang.reflect.Field;
import java.util.LinkedHashMap;
import java.util.Map;
import org.hibernate.boot.Metadata;
import org.hibernate.mapping.PersistentClass;
import org.hibernate.mapping.Property;

/**
 * The optimistic-locking column ({@code @Version}) of every versioned entity, by table, as Hibernate itself maps it.
 * Only the root of a hierarchy is listed: its subclasses share the version of the root. Annotations are found by their
 * simple name, so the same code runs against {@code javax.persistence} and {@code jakarta.persistence}.
 */
final class Versions {
  private Versions() {}

  static Map<String, Object> of(Metadata metadata) {
    Map<String, Object> versions = new LinkedHashMap<>();
    for (PersistentClass binding : metadata.getEntityBindings()) {
      if (binding.getSuperclass() != null || !binding.isVersioned() || binding.getVersion() == null) {
        continue;
      }
      Property version = binding.getVersion();
      versions.put(binding.getTable().getName(), columnOf(binding.getMappedClass(), version.getName()));
    }
    return versions;
  }

  /** The column of an attribute: the name of its {@code @Column}, else the attribute name. */
  private static String columnOf(Class<?> type, String attribute) {
    for (Class<?> current = type; current != null && current != Object.class; current = current.getSuperclass()) {
      for (Field field : current.getDeclaredFields()) {
        if (!field.getName().equals(attribute)) {
          continue;
        }
        for (Annotation annotation : field.getAnnotations()) {
          if (!annotation.annotationType().getSimpleName().equals("Column")) {
            continue;
          }
          try {
            Object name = annotation.annotationType().getMethod("name").invoke(annotation);
            if (name instanceof String && !((String) name).isEmpty()) {
              return (String) name;
            }
          } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
          }
        }
        return attribute;
      }
    }
    return attribute;
  }
}
