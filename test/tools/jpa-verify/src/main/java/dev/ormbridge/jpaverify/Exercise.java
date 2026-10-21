package dev.ormbridge.jpaverify;

import java.lang.annotation.Annotation;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.hibernate.Session;
import org.hibernate.SessionFactory;
import org.hibernate.Transaction;
import org.hibernate.boot.Metadata;
import org.hibernate.mapping.PersistentClass;

/**
 * Adds one row to every table through the entity classes, the way an application would: the instance is built by
 * reflection from the annotations (a sample value for every column that has no default, the previously saved row for
 * every relation), saved with {@code Session.persist}, and read back with SQL. Nothing here is specific to Jakarta or
 * to Hibernate 6: annotations are found by their simple name, so the same code runs against {@code javax.persistence}
 * and Hibernate 5.
 *
 * <p>The result is {@code {"rows": {table: {column: value}}, "updates": {table: {column: [before, after]}},
 * "errors": [...]}}: the row of each table, the columns that {@code @UpdateTimestamp} refreshed when a second
 * session changed another attribute, and everything that went wrong.
 */
final class Exercise {
  private final SessionFactory factory;
  private final Metadata metadata;
  private final Connection connection;
  private final Map<Class<?>, Object> saved = new LinkedHashMap<>();
  private final Map<String, Object> rows = new LinkedHashMap<>();
  private final Map<String, Object> updates = new LinkedHashMap<>();
  private final List<String> errors = new ArrayList<>();
  private int counter = 0;

  Exercise(SessionFactory factory, Metadata metadata, Connection connection) {
    this.factory = factory;
    this.metadata = metadata;
    this.connection = connection;
  }

  /** Columns that a foreign key uses on either end; changing one of them would break the key. */
  private final java.util.Set<String> keyColumns = new java.util.HashSet<>();

  Map<String, Object> run(List<Class<?>> classes) {
    for (Class<?> type : classes) {
      for (Field field : fields(type)) {
        for (String note : new String[] {"JoinColumn", "JoinColumns"}) {
          Annotation join = find(field, note);
          if (join == null) {
            continue;
          }
          Object[] list = note.equals("JoinColumns") ? (Object[]) value(join, "value") : new Object[] {join};
          for (Object item : list) {
            keyColumns.add(String.valueOf(value((Annotation) item, "name")));
            keyColumns.add(String.valueOf(value((Annotation) item, "referencedColumnName")));
          }
        }
      }
    }
    List<Class<?>> entities = new ArrayList<>();
    for (Class<?> type : classes) {
      if (find(type, "Entity") != null) {
        entities.add(type);
      }
    }
    List<Class<?>> pending = new ArrayList<>(entities);
    boolean progress = true;
    while (!pending.isEmpty() && progress) {
      progress = false;
      for (Class<?> type : new ArrayList<>(pending)) {
        if (!ready(type)) {
          continue;
        }
        pending.remove(type);
        progress = true;
        save(type);
      }
    }
    for (Class<?> type : pending) {
      errors.add(
          type.getSimpleName()
              + ": a required relationship points at a class that could not be saved first");
    }
    for (Class<?> type : entities) {
      if (saved.containsKey(type)) {
        rows.put(tableName(type), readRow(type));
        refresh(type);
      }
    }
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("rows", rows);
    result.put("updates", updates);
    result.put("errors", errors);
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Annotations by simple name
  // -------------------------------------------------------------------------------------------

  private static Annotation find(java.lang.reflect.AnnotatedElement element, String simpleName) {
    for (Annotation annotation : element.getAnnotations()) {
      if (annotation.annotationType().getSimpleName().equals(simpleName)) {
        return annotation;
      }
    }
    return null;
  }

  private static Object value(Annotation annotation, String member) {
    try {
      return annotation.annotationType().getMethod(member).invoke(annotation);
    } catch (ReflectiveOperationException e) {
      return null;
    }
  }

  private static List<Field> fields(Class<?> type) {
    List<Field> result = new ArrayList<>();
    for (Class<?> current = type; current != null && current != Object.class; current = current.getSuperclass()) {
      List<Field> own = new ArrayList<>(Arrays.asList(current.getDeclaredFields()));
      result.addAll(0, own);
    }
    return result;
  }

  private static boolean persistent(Field field) {
    return !Modifier.isStatic(field.getModifiers())
        && !Modifier.isTransient(field.getModifiers())
        && find(field, "Transient") == null
        && find(field, "OneToMany") == null
        && find(field, "ManyToMany") == null
        && find(field, "ElementCollection") == null
        && !field.isSynthetic();
  }

  private static boolean isRelation(Field field) {
    return find(field, "ManyToOne") != null || find(field, "OneToOne") != null;
  }

  private static boolean required(Field field) {
    if (find(field, "Id") != null) {
      return true;
    }
    Annotation relation = find(field, "ManyToOne") != null ? find(field, "ManyToOne") : find(field, "OneToOne");
    if (relation != null && Boolean.FALSE.equals(value(relation, "optional"))) {
      return true;
    }
    Annotation join = find(field, "JoinColumn");
    return join != null && Boolean.FALSE.equals(value(join, "nullable"));
  }

  private boolean ready(Class<?> type) {
    for (Field field : fields(type)) {
      if (persistent(field) && isRelation(field) && required(field)
          && !saved.containsKey(field.getType())) {
        return false;
      }
    }
    return true;
  }

  private String tableName(Class<?> type) {
    PersistentClass binding = metadata.getEntityBinding(type.getName());
    return binding.getTable().getName();
  }

  // -------------------------------------------------------------------------------------------
  // Building and saving an instance
  // -------------------------------------------------------------------------------------------

  private boolean leftToTheDatabase(Field field) {
    return find(field, "ColumnDefault") != null
        || find(field, "UuidGenerator") != null
        || find(field, "CreationTimestamp") != null
        || find(field, "UpdateTimestamp") != null
        || find(field, "GeneratedColumn") != null
        || find(field, "Version") != null
        || find(field, "GeneratedValue") != null;
  }

  private void save(Class<?> type) {
    try {
      Object instance = type.getDeclaredConstructor().newInstance();
      for (Field field : fields(type)) {
        if (!persistent(field)) {
          continue;
        }
        field.setAccessible(true);
        if (isRelation(field)) {
          Object target = saved.get(field.getType());
          if (target != null && field.getType() != type) {
            field.set(instance, target);
          }
          continue;
        }
        if (find(field, "Embedded") != null || find(field, "EmbeddedId") != null) {
          // An @EmbeddedId is built below, once the relationships it takes values from are set.
          continue;
        }
        boolean assigned = find(field, "Id") != null && find(field, "GeneratedValue") == null;
        if (leftToTheDatabase(field) && !assigned) {
          continue;
        }
        Object sample = sample(field.getType(), field);
        if (sample != null) {
          field.set(instance, sample);
        }
      }
      copyJoinColumns(type, instance);
      buildEmbeddedId(type, instance);
      try (Session session = factory.openSession()) {
        Transaction transaction = session.beginTransaction();
        try {
          // A relationship that is part of the key rejects a detached entity; a reference by id is accepted.
          var util = factory.getPersistenceUnitUtil();
          for (Field field : fields(type)) {
            if (persistent(field)
                && isRelation(field)
                && (find(field, "Id") != null || find(field, "MapsId") != null)) {
              field.setAccessible(true);
              Object target = field.get(instance);
              if (target != null) {
                field.set(instance, session.getReference(target.getClass(), util.getIdentifier(target)));
              }
            }
          }
          session.persist(instance);
          transaction.commit();
        } catch (RuntimeException e) {
          transaction.rollback();
          throw e;
        }
      }
      saved.put(type, instance);
      readBack(type, instance);
    } catch (Throwable thrown) {
      Throwable root = thrown;
      while (root.getCause() != null && root.getCause() != root) {
        root = root.getCause();
      }
      errors.add(type.getSimpleName() + ": " + thrown + (root == thrown ? "" : " <- " + root));
    }
  }

  /** The attribute of the entity whose {@code @MapsId} names a part of the embedded id, or null. */
  private static Field mapsIdRelation(Class<?> type, String part) {
    for (Field field : fields(type)) {
      Annotation maps = find(field, "MapsId");
      if (maps != null && isRelation(field) && part.equals(value(maps, "value"))) {
        return field;
      }
    }
    return null;
  }

  /**
   * Builds the value of an {@code @EmbeddedId}: a part that an {@code @MapsId} relationship supplies takes the key of
   * the saved target, every other part a sample value.
   */
  private void buildEmbeddedId(Class<?> type, Object instance) throws Exception {
    for (Field field : fields(type)) {
      if (!persistent(field) || find(field, "EmbeddedId") == null) {
        continue;
      }
      field.setAccessible(true);
      Object key = field.getType().getDeclaredConstructor().newInstance();
      for (Field part : fields(field.getType())) {
        if (!persistent(part)) {
          continue;
        }
        part.setAccessible(true);
        Object value;
        Field owner = mapsIdRelation(type, part.getName());
        if (owner != null) {
          owner.setAccessible(true);
          Object target = owner.get(instance);
          value = target == null ? null : factory.getPersistenceUnitUtil().getIdentifier(target);
        } else {
          value = sample(part.getType(), part);
        }
        if (value != null) {
          part.set(key, value);
        }
      }
      field.set(instance, key);
    }
  }

  /**
   * Loads a row with an embedded id by its key in a new session and checks that the key Hibernate reports equals the
   * one that was saved (so {@code equals} and {@code hashCode} of the key class, including Lombok's, work).
   */
  private void readBack(Class<?> type, Object instance) throws Exception {
    for (Field field : fields(type)) {
      if (!persistent(field) || find(field, "EmbeddedId") == null) {
        continue;
      }
      field.setAccessible(true);
      Object key = field.get(instance);
      // Hibernate 5 stores a UUID as binary(255) on H2, which pads the value, so a lookup by it finds nothing; that is
      // a property of the database, as with the update below.
      if (hasUuidPart(key) && find(type, "Entity").annotationType().getName().startsWith("javax.")) {
        continue;
      }
      try (Session session = factory.openSession()) {
        Object found = session.find(type, key);
        if (found == null) {
          errors.add(type.getSimpleName() + ": the row saved with the embedded id " + key.getClass().getSimpleName() + " was not found by it");
          continue;
        }
        Object reported = factory.getPersistenceUnitUtil().getIdentifier(found);
        if (!key.equals(reported) || key.hashCode() != reported.hashCode()) {
          errors.add(type.getSimpleName() + ": the embedded id read back differs from the one saved");
        }
      }
    }
  }

  /** The value of a column of an instance: a basic attribute, or the key a relationship points at. */
  private Object columnValue(Object instance, String column, int depth) throws Exception {
    if (instance == null || depth > 4) {
      return null;
    }
    for (Field field : fields(instance.getClass())) {
      if (!persistent(field)) {
        continue;
      }
      field.setAccessible(true);
      if (find(field, "EmbeddedId") != null) {
        // The columns of an embedded id are the attributes of its key class.
        Object inKey = columnValue(field.get(instance), column, depth + 1);
        if (inKey != null) {
          return inKey;
        }
        continue;
      }
      if (isRelation(field)) {
        Annotation join = find(field, "JoinColumn");
        if (join != null && column.equals(value(join, "name"))) {
          Object target = field.get(instance);
          Object referenced = value(join, "referencedColumnName");
          return target == null ? null : columnValue(target, String.valueOf(referenced), depth + 1);
        }
        continue;
      }
      Annotation columnNote = find(field, "Column");
      Object name = columnNote == null ? null : value(columnNote, "name");
      if (column.equals(name)) {
        return field.get(instance);
      }
    }
    return null;
  }

  /** A relationship with several join columns reads its scalar columns; give them the key of the saved target. */
  private void copyJoinColumns(Class<?> type, Object instance) throws Exception {
    for (Field field : fields(type)) {
      Annotation joins = find(field, "JoinColumns");
      Object target = saved.get(field.getType());
      if (joins == null || target == null || !persistent(field)) {
        continue;
      }
      for (Object join : (Object[]) value(joins, "value")) {
        Annotation note = (Annotation) join;
        Object local = value(note, "name");
        Object referenced = value(note, "referencedColumnName");
        Object copied = columnValue(target, String.valueOf(referenced), 0);
        for (Field scalar : fields(type)) {
          Annotation column = find(scalar, "Column");
          if (column != null && local.equals(value(column, "name")) && !isRelation(scalar)) {
            scalar.setAccessible(true);
            scalar.set(instance, copied);
          }
        }
      }
    }
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private Object sample(Class<?> type, Field field) throws Exception {
    counter += 1;
    if (type.isEnum()) {
      Object[] constants = type.getEnumConstants();
      return constants.length == 0 ? null : constants[0];
    }
    if (type == String.class) {
      String text = "s" + counter;
      Annotation column = find(field, "Column");
      Object length = column == null ? null : value(column, "length");
      if (length instanceof Integer && (Integer) length < text.length()) {
        return text.substring(0, Math.max(1, (Integer) length));
      }
      Annotation definition = column;
      Object sql = definition == null ? null : value(definition, "columnDefinition");
      if (sql instanceof String && ((String) sql).toLowerCase().contains("json")) {
        return "{}";
      }
      return text;
    }
    if (type == int.class || type == Integer.class) return 3;
    if (type == long.class || type == Long.class) return 4L;
    if (type == short.class || type == Short.class) return (short) 5;
    if (type == byte.class || type == Byte.class) return (byte) 6;
    if (type == double.class || type == Double.class) return 1.5d;
    if (type == float.class || type == Float.class) return 1.5f;
    if (type == boolean.class || type == Boolean.class) return Boolean.TRUE;
    if (type == char.class || type == Character.class) return 'a';
    if (type == BigDecimal.class) return BigDecimal.ONE;
    if (type == LocalDate.class) return LocalDate.of(2024, 1, 2);
    if (type == LocalTime.class) return LocalTime.of(3, 4, 5);
    if (type == LocalDateTime.class) return LocalDateTime.of(2024, 1, 2, 3, 4, 5);
    if (type == OffsetDateTime.class) return OffsetDateTime.of(2024, 1, 2, 3, 4, 5, 0, ZoneOffset.UTC);
    if (type == Instant.class) return Instant.parse("2024-01-02T03:04:05Z");
    if (type == Duration.class) return Duration.ofSeconds(90);
    if (type == UUID.class) return UUID.randomUUID();
    if (type == InetAddress.class) return InetAddress.getByName("10.0.0.1");
    if (type == byte[].class) return new byte[] {1, 2, 3};
    if (type == Map.class) {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("a", 1);
      return map;
    }
    if (type.isArray()) {
      Class<?> element = type.getComponentType();
      Object one = sample(element, field);
      if (one == null) {
        return null;
      }
      Object array = java.lang.reflect.Array.newInstance(element, 1);
      java.lang.reflect.Array.set(array, 0, one);
      return array;
    }
    if (type == List.class) {
      java.lang.reflect.Type generic = field.getGenericType();
      Class<?> element = String.class;
      if (generic instanceof java.lang.reflect.ParameterizedType) {
        java.lang.reflect.Type argument = ((java.lang.reflect.ParameterizedType) generic).getActualTypeArguments()[0];
        if (argument instanceof Class) {
          element = (Class<?>) argument;
        }
      }
      Object one = sample(element, field);
      List<Object> list = new ArrayList<>();
      if (one != null) {
        list.add(one);
      }
      return list;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Reading rows back
  // -------------------------------------------------------------------------------------------

  private static Object plain(Object value) {
    if (value == null || value instanceof Number || value instanceof Boolean || value instanceof String) {
      return value;
    }
    if (value instanceof byte[]) {
      StringBuilder hex = new StringBuilder();
      for (byte b : (byte[]) value) {
        hex.append(String.format("%02x", b));
      }
      return hex.toString();
    }
    if (value instanceof java.sql.Clob) {
      try {
        java.sql.Clob clob = (java.sql.Clob) value;
        return clob.getSubString(1, (int) clob.length());
      } catch (Exception e) {
        return value.toString();
      }
    }
    if (value instanceof java.sql.Array) {
      try {
        return String.valueOf(Arrays.deepToString((Object[]) ((java.sql.Array) value).getArray()));
      } catch (Exception e) {
        return value.toString();
      }
    }
    return value.toString();
  }

  private Map<String, Object> readRow(Class<?> type) {
    PersistentClass binding = metadata.getEntityBinding(type.getName());
    String schema = binding.getTable().getSchema();
    String table = binding.getTable().getName();
    String qualified = (schema == null ? "" : "\"" + schema + "\".") + "\"" + table + "\"";
    try (Statement statement = connection.createStatement();
        ResultSet rows = statement.executeQuery("SELECT * FROM " + qualified)) {
      ResultSetMetaData meta = rows.getMetaData();
      if (!rows.next()) {
        return null;
      }
      Map<String, Object> row = new LinkedHashMap<>();
      for (int index = 1; index <= meta.getColumnCount(); index++) {
        row.put(meta.getColumnName(index), plain(rows.getObject(index)));
      }
      return row;
    } catch (Exception e) {
      errors.add(table + ": reading the row failed: " + e);
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // @UpdateTimestamp
  // -------------------------------------------------------------------------------------------

  /** Changes one attribute of the saved instance, updates it in a second session and reports the columns Hibernate refreshed by itself. */
  private void refresh(Class<?> type) {
    List<Field> stamps = new ArrayList<>();
    Field dirty = null;
    for (Field field : fields(type)) {
      if (!persistent(field) || isRelation(field)) {
        continue;
      }
      if (find(field, "UpdateTimestamp") != null) {
        stamps.add(field);
      } else if (dirty == null
          && find(field, "Id") == null
          && find(field, "GeneratedColumn") == null
          && find(field, "CreationTimestamp") == null
          && (field.getType() == String.class || field.getType() == int.class || field.getType() == Integer.class)
          && !isReadOnly(field)
          && !isLinked(field)) {
        dirty = field;
      }
    }
    if (stamps.isEmpty() || dirty == null) {
      return;
    }
    String table = tableName(type);
    Map<String, Object> before = readRow(type);
    try {
      Thread.sleep(25);
      try (Session session = factory.openSession()) {
        Transaction transaction = session.beginTransaction();
        Object managed = saved.get(type);
        // The instance still holds null where the database filled in a default; an update writes every column.
        for (Field field : fields(type)) {
          if (persistent(field) && !isRelation(field) && find(field, "ColumnDefault") != null) {
            field.setAccessible(true);
            if (field.get(managed) == null) {
              field.set(managed, sample(field.getType(), field));
            }
          }
        }
        dirty.setAccessible(true);
        Object current = dirty.get(managed);
        if (current instanceof String) {
          Annotation column = find(dirty, "Column");
          Object length = column == null ? null : value(column, "length");
          String changed = ((String) current).length() > 1 ? ((String) current).substring(1) : "z";
          if (length instanceof Integer && changed.length() > (Integer) length) {
            changed = changed.substring(0, (Integer) length);
          }
          dirty.set(managed, changed + (changed.equals(current) ? "y" : ""));
        } else {
          dirty.set(managed, current == null ? Integer.valueOf(7) : Integer.valueOf(((Integer) current) + 1));
        }
        session.update(managed);
        session.flush();
        transaction.commit();
      }
    } catch (Throwable thrown) {
      // Hibernate 5 stores a UUID as binary(255) on H2, which pads the value, so the update's WHERE clause matches
      // no row (and a key made of relationships is rebuilt from proxies); that is a property of the database and of
      // the test, not of the mapping.
      if (!(thrown.toString().contains("row count") && (hasUuidKey(type) || hasIdRelation(type)))) {
        errors.add(type.getSimpleName() + ": changing a row failed: " + thrown);
      }
      return;
    }
    Map<String, Object> after = readRow(type);
    Map<String, Object> changes = new LinkedHashMap<>();
    for (Field stamp : stamps) {
      Annotation column = find(stamp, "Column");
      Object name = column == null ? null : value(column, "name");
      String columnName = name instanceof String && !((String) name).isEmpty() ? (String) name : stamp.getName();
      List<Object> pair = new ArrayList<>();
      pair.add(before == null ? null : before.get(columnName));
      pair.add(after == null ? null : after.get(columnName));
      changes.put(columnName, pair);
    }
    updates.put(table, changes);
  }

  private boolean isLinked(Field field) {
    Annotation column = find(field, "Column");
    Object name = column == null ? null : value(column, "name");
    return Boolean.TRUE.equals(column == null ? null : value(column, "unique"))
        || keyColumns.contains(String.valueOf(name))
        || keyColumns.contains(field.getName());
  }

  private static boolean hasIdRelation(Class<?> type) {
    for (Field field : fields(type)) {
      if ((find(field, "Id") != null || find(field, "MapsId") != null) && isRelation(field)) {
        return true;
      }
    }
    return false;
  }

  private static boolean hasUuidPart(Object key) {
    for (Field part : fields(key.getClass())) {
      if (persistent(part) && part.getType() == UUID.class) {
        return true;
      }
    }
    return false;
  }

  private static boolean hasUuidKey(Class<?> type) {
    for (Field field : fields(type)) {
      if (find(field, "Id") != null && field.getType() == UUID.class) {
        return true;
      }
    }
    return false;
  }

  private static boolean isReadOnly(Field field) {
    Annotation column = find(field, "Column");
    return column != null
        && (Boolean.FALSE.equals(value(column, "updatable")) || Boolean.FALSE.equals(value(column, "insertable")));
  }
}
