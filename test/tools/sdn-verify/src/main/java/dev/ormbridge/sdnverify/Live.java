package dev.ormbridge.sdnverify;

import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.neo4j.driver.Driver;
import org.springframework.data.neo4j.core.Neo4jTemplate;
import org.springframework.data.neo4j.core.mapping.Neo4jMappingContext;
import org.springframework.data.neo4j.core.mapping.Neo4jPersistentEntity;

/**
 * Saves a small graph of the generated classes through {@link Neo4jTemplate} in a real Neo4j server, reads it back
 * and checks the stored labels, property names, relationship types and relationship properties with Cypher. Only the
 * groups {@code blog} (the canonical blog schema) and {@code joins} (join tables) have a scenario.
 */
final class Live {
  private Live() {}

  private static final List<Map<String, Object>> CHECKS = new ArrayList<>();

  private static void check(String name, boolean ok, Object detail) {
    Map<String, Object> entry = new LinkedHashMap<>();
    entry.put("name", name);
    entry.put("ok", ok);
    entry.put("detail", String.valueOf(detail));
    CHECKS.add(entry);
  }

  /** The graph property name that Spring Data Neo4j stores a field under. */
  private static String stored(Neo4jMappingContext context, Class<?> type, String field) {
    Neo4jPersistentEntity<?> entity = context.getRequiredPersistentEntity(type);
    return entity.getGraphProperty(field).orElseThrow().getPropertyName();
  }

  private static Object one(Driver driver, String cypher) {
    try (var session = driver.session()) {
      var result = session.run(cypher);
      return result.hasNext() ? result.next().get(0).asObject() : null;
    }
  }

  static List<Map<String, Object>> run(String group, Neo4jMappingContext context, ClassLoader loader)
      throws Exception {
    CHECKS.clear();
    try (Driver driver = Main.driver()) {
      one(driver, "MATCH (n) DETACH DELETE n");
      Neo4jTemplate template = Main.template(context, driver);
      if (group.equals("blog")) {
        blog(driver, template, context, loader);
      } else if (group.equals("joins")) {
        joins(driver, template, context, loader);
      }
    }
    return new ArrayList<>(CHECKS);
  }

  @SuppressWarnings("unchecked")
  private static void blog(Driver driver, Neo4jTemplate template, Neo4jMappingContext context, ClassLoader loader)
      throws Exception {
    Class<?> userType = Class.forName("app.models.User", true, loader);
    Class<?> categoryType = Class.forName("app.models.Category", true, loader);
    Class<?> tagType = Class.forName("app.models.Tag", true, loader);
    Class<?> postType = Class.forName("app.models.Post", true, loader);
    Class<?> statusType = Class.forName("app.models.PostStatus", true, loader);

    Object user = template.save(Main.create(loader, "app.models.User"));
    Object category = Main.create(loader, "app.models.Category");
    Main.set(category, "name", "news");
    Main.set(category, "slug", "news");
    category = template.save(category);
    Object tag = Main.create(loader, "app.models.Tag");
    Main.set(tag, "label", "graphs");
    tag = template.save(tag);

    Object post = Main.create(loader, "app.models.Post");
    UUID publicId = UUID.randomUUID();
    Main.set(post, "publicId", publicId);
    Main.set(post, "title", "Hello");
    Main.set(post, "body", "First post");
    Main.set(post, "publishedAt", ZonedDateTime.parse("2024-05-01T12:30:00Z"));
    Main.set(post, "author", user);
    Main.set(post, "category", category);
    Object tagLink = tag;
    boolean tagProperties = exists(loader, "app.models.PostTagTag");
    if (tagProperties) {
      // The join table has columns of its own (the normalize naming mode adds timestamps): the list holds the relationship class.
      tagLink = Main.create(loader, "app.models.PostTagTag");
      Main.set(tagLink, "tag", tag);
    }
    Main.set(post, "tags", new ArrayList<>(List.of(tagLink)));
    post = template.save(post);
    Object postId = Main.get(post, "id");
    check("the saved node has an identifier", postId != null, postId);

    System.err.println("DEBUG client=" + org.springframework.data.neo4j.core.Neo4jClient.create(driver).query("MATCH (t:Tag) RETURN count(t) AS c").fetch().one());
    var cl = org.springframework.data.neo4j.core.Neo4jClient.create(driver);
    System.err.println("DEBUG q1=" + cl.query("MATCH (tag:`Tag`) WITH collect(toString(id(tag))) AS __sn__ RETURN __sn__").fetch().all());
    System.err.println("DEBUG q3=" + cl.query("MATCH (rootNodeIds:`Tag`) WHERE toString(id(rootNodeIds)) IN $rootNodeIds WITH collect(rootNodeIds) AS n OPTIONAL MATCH ()-[relationshipIds]-() WHERE toString(id(relationshipIds)) IN $relationshipIds WITH n, collect(DISTINCT relationshipIds) AS __sr__ OPTIONAL MATCH (relatedNodeIds) WHERE toString(id(relatedNodeIds)) IN $relatedNodeIds WITH n, __sr__ AS __sr__, collect(DISTINCT relatedNodeIds) AS __srn__ UNWIND n AS rootNodeIds WITH rootNodeIds AS tag, __sr__, __srn__ RETURN tag AS __sn__, __sr__, __srn__").bind(((java.util.Collection<?>) cl.query("MATCH (tag:`Tag`) WITH collect(toString(id(tag))) AS ids RETURN ids").fetch().one().get().get("ids")).stream().map(String::valueOf).toList()).to("rootNodeIds").bind(List.of()).to("relationshipIds").bind(List.of()).to("relatedNodeIds").fetch().all().size());
    System.err.println("DEBUG viaQuery=" + template.findAll("MATCH (t:Tag) RETURN t", (Class<Object>) tagType).size());
    System.err.println("DEBUG user=" + template.findAll((Class<Object>) userType).size() + " cat=" + template.findAll((Class<Object>) categoryType).size() + " tag=" + template.findAll((Class<Object>) tagType).size());
    System.err.println("DEBUG id=" + postId + " type=" + (postId == null ? null : postId.getClass()) + " all=" + template.findAll((Class<Object>) postType).size());
    Object loaded = template.findById(postId, (Class<Object>) postType).orElseThrow();
    check("a string property is read back", "Hello".equals(Main.get(loaded, "title")), Main.get(loaded, "title"));
    check("a UUID property is read back", publicId.equals(Main.get(loaded, "publicId")), Main.get(loaded, "publicId"));
    check(
        "a zoned date and time is read back",
        ZonedDateTime.parse("2024-05-01T12:30:00Z").toInstant().equals(((ZonedDateTime) Main.get(loaded, "publishedAt")).toInstant()),
        Main.get(loaded, "publishedAt"));
    check("the enum default is kept", String.valueOf(Main.get(loaded, "status")).equals("DRAFT"), Main.get(loaded, "status"));
    check("a relationship is read back", Main.get(loaded, "author") != null, Main.get(loaded, "author"));
    check("a to-many relationship is read back", ((List<?>) Main.get(loaded, "tags")).size() == 1, Main.get(loaded, "tags"));
    Object reverse = template.findById(Main.get(tag, "id"), (Class<Object>) tagType).orElseThrow();
    check("the reverse side sees the relationship", ((List<?>) Main.get(reverse, "posts")).size() == 1, Main.get(reverse, "posts"));
    Object reloadedUser = template.findById(Main.get(user, "id"), (Class<Object>) userType).orElseThrow();
    check("an incoming list holds the post", ((List<?>) Main.get(reloadedUser, "posts")).size() == 1, Main.get(reloadedUser, "posts"));

    check("the label is stored", one(driver, "MATCH (p:Post) RETURN count(p)").equals(1L), "");
    check(
        "the relationship type and direction are stored",
        one(driver, "MATCH (:Post)-[r:AUTHOR]->(:User) RETURN count(r)").equals(1L)
            && one(driver, "MATCH (:Post)-[r:TAGS]->(:Tag) RETURN count(r)").equals(1L),
        "");
    String publicKey = stored(context, postType, "publicId");
    check(
        "a renamed property is stored under its graph key",
        one(driver, "MATCH (p:Post) RETURN p.`" + publicKey + "` IS NOT NULL").equals(Boolean.TRUE),
        publicKey);
    String statusKey = stored(context, postType, "status");
    Object storedStatus = one(driver, "MATCH (p:Post) RETURN p.`" + statusKey + "`");
    check("an enum is stored as its source value", "draft".equals(storedStatus), storedStatus);
    check("the class kept its enum constants", statusType.isEnum(), statusType.getName());
    Object second = Main.create(loader, "app.models.Category");
    Main.set(second, "name", "other");
    Main.set(second, "slug", "other");
    template.save(second);
    check("two categories are stored", one(driver, "MATCH (c:Category) RETURN count(c)").equals(2L), "");
    check("a node can be deleted", deleted(template, second, categoryType), "");
  }

  private static boolean exists(ClassLoader loader, String name) {
    try {
      Class.forName(name, true, loader);
      return true;
    } catch (ClassNotFoundException error) {
      return false;
    }
  }

  @SuppressWarnings("unchecked")
  private static boolean deleted(Neo4jTemplate template, Object node, Class<?> type) throws Exception {
    template.deleteById(Main.get(node, "id"), type);
    return template.findAll((Class<Object>) type).size() == 1;
  }

  @SuppressWarnings("unchecked")
  private static void joins(Driver driver, Neo4jTemplate template, Neo4jMappingContext context, ClassLoader loader)
      throws Exception {
    Class<?> studentType = Class.forName("app.models.Student", true, loader);
    Class<?> courseType = Class.forName("app.models.Course", true, loader);
    Object course = template.save(Main.create(loader, "app.models.Course"));
    Object teacher = template.save(Main.create(loader, "app.models.Teacher"));
    Object student = Main.create(loader, "app.models.Student");
    Object enrollment = Main.create(loader, "app.models.EnrollmentCourse");
    Main.set(enrollment, "ticket", "t1");
    Main.set(enrollment, "seat", 4);
    Main.set(enrollment, "course", course);
    Main.set(student, "courses", new ArrayList<>(List.of(enrollment)));
    student = template.save(student);

    Object loaded = template.findById(Main.get(student, "id"), (Class<Object>) studentType).orElseThrow();
    List<?> courses = (List<?>) Main.get(loaded, "courses");
    check("a relationship with properties is read back", courses.size() == 1, courses.size());
    Object back = courses.get(0);
    check("a relationship property is read back", "t1".equals(Main.get(back, "ticket")) && Integer.valueOf(4).equals(Main.get(back, "seat")), Main.get(back, "ticket"));
    check("the relationship target is read back", Main.get(back, "course") != null, "");
    String ticketKey = stored(context, Class.forName("app.models.EnrollmentCourse", true, loader), "ticket");
    check(
        "the relationship property is stored on the relationship",
        "t1".equals(one(driver, "MATCH (:Student)-[r:COURSES]->(:Course) RETURN r.`" + ticketKey + "`")),
        ticketKey);
    Object loadedCourse = template.findById(Main.get(course, "id"), (Class<Object>) courseType).orElseThrow();
    List<?> students = (List<?>) Main.get(loadedCourse, "students");
    check("the incoming side reads the relationship properties", students.size() == 1 && "t1".equals(Main.get(students.get(0), "ticket")), students.size());

    Main.set(loadedCourse, "teachers", new ArrayList<>(List.of(teacher)));
    template.save(loadedCourse);
    Object reloadedTeacher = template.findById(Main.get(teacher, "id"), (Class<Object>) Class.forName("app.models.Teacher", true, loader)).orElseThrow();
    check("a many-to-many pair is read from both sides", ((List<?>) Main.get(reloadedTeacher, "courses")).size() == 1, "");
    check("the many-to-many type is stored", one(driver, "MATCH (:Course)-[r:TEACHERS]->(:Teacher) RETURN count(r)").equals(1L), "");
  }
}
