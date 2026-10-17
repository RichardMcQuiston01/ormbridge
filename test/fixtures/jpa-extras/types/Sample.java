package extras.types;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Basic;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.OrderColumn;
import jakarta.persistence.Temporal;
import jakarta.persistence.TemporalType;
import jakarta.persistence.Transient;
import jakarta.persistence.Version;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Blob;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.hibernate.annotations.ColumnDefault;
import org.hibernate.annotations.Comment;
import org.hibernate.annotations.Formula;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.NaturalId;
import org.hibernate.type.SqlTypes;
import org.hibernate.validator.constraints.Length;

/** Every kind of column in one entity, with the table named after the class. */
@Entity
public class Sample {
  @Id @GeneratedValue private Long id;

  // Strings and Bean Validation hints.
  private String plain;

  @Column(nullable = false)
  private String required;

  @Size(max = 40)
  private String sized;

  @NotNull
  @Length(max = 30)
  private String validated;

  @NotBlank private String blank;

  @NotEmpty private String nonEmpty;

  @Email private String email;

  @Column(unique = true)
  private String code;

  @Basic(optional = false)
  private String basicRequired;

  @NaturalId private String naturalKey;

  @Comment("a column comment")
  private String commented;

  // Numbers and booleans.
  private int count;
  private Integer maybeCount;
  private short small;
  private Byte tiny;
  private long big;
  private boolean flag;
  private Boolean maybeFlag;
  private float single;
  private double twice;
  private BigDecimal money;

  @Column(precision = 10, scale = 3)
  private BigDecimal precise;

  @Digits(integer = 5, fraction = 1)
  private BigDecimal digits;

  private BigInteger huge;
  private char letter;
  private Character maybeLetter;

  @ColumnDefault("42")
  private int answer;

  // Dates and times.
  private LocalDate day;
  private LocalTime time;
  private LocalDateTime stamp;
  private Instant instant;
  private OffsetDateTime offset;
  private ZonedDateTime zoned;
  private Duration duration;

  @Temporal(TemporalType.DATE)
  private Date legacyDate;

  @Temporal(TemporalType.TIMESTAMP)
  private Date legacyStamp;

  @Temporal(TemporalType.TIME)
  private Date legacyTime;

  @Temporal(TemporalType.TIMESTAMP)
  private Calendar calendar;

  private java.sql.Date sqlDate;
  private Timestamp sqlStamp;

  // Binary data, large objects, identifiers and JSON.
  private UUID uuid;
  private byte[] bytes;

  @Lob private byte[] blob;

  @Lob private String clob;

  private Blob handle;

  @JdbcTypeCode(SqlTypes.JSON)
  private Map<String, Object> json;

  @JdbcTypeCode(SqlTypes.JSON)
  private JsonNode node;

  // Enums: by name, and by number (the default).
  @Enumerated(EnumType.STRING)
  private Level level;

  private Color color;

  // Converters and column definitions.
  @Convert(converter = MoneyConverter.class)
  private Money price;

  @Column(columnDefinition = "varchar(12) not null default 'x'")
  private String legacyDefinition;

  @Version private long version;

  // Not columns.
  @Transient private String scratch;
  private transient String cache;
  private static String shared = "";

  @Formula("count * 2")
  private int doubled;

  // Collections of basic values live in child tables.
  @ElementCollection private List<String> nicknames;

  @ElementCollection
  @Enumerated(EnumType.STRING)
  private Set<Level> levels;

  @ElementCollection
  @OrderColumn
  private List<String> ordered;
}
