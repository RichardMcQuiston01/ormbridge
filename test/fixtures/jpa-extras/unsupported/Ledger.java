package extras.unsupported;

import jakarta.persistence.AssociationOverride;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.NamedNativeQuery;
import jakarta.persistence.NamedQuery;
import jakarta.persistence.OneToMany;
import jakarta.persistence.SecondaryTable;
import jakarta.persistence.SqlResultSetMapping;
import jakarta.persistence.Table;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.hibernate.annotations.Check;
import org.hibernate.annotations.Comment;
import org.hibernate.annotations.Filter;
import org.hibernate.annotations.Formula;
import org.hibernate.annotations.TenantId;
import org.hibernate.envers.Audited;

// A bag of constructs the reader cannot represent. Each one is reported, none stops the read.
@Entity
@Table(name = "ledger", schema = "finance")
@SecondaryTable(name = "ledger_extra")
@NamedQuery(name = "Ledger.all", query = "select l from Ledger l")
@NamedNativeQuery(name = "Ledger.raw", query = "select * from ledger")
@SqlResultSetMapping(name = "LedgerSummary")
@Audited
@Check(constraints = "amount >= 0")
@Comment("The general ledger")
@Filter(name = "activeOnly")
@AssociationOverride(name = "owner", joinColumns = @jakarta.persistence.JoinColumn(name = "o"))
public class Ledger extends AbstractPersistable<Long> {
  @Id private Long id;

  @Column(table = "ledger_extra")
  private String memo;

  @TenantId private String tenant;

  @Formula("amount * 2")
  private long doubled;

  private Optional<String> note;

  @ElementCollection private Map<String, String> labels;

  @ElementCollection private List<Entry> entries;

  @Embedded private Missing missing;

  @OneToMany private List<Unknown> unknown;

  @ManyToOne private Ledger parent;

  @jakarta.persistence.Convert(converter = MissingConverter.class)
  private Missing converted;
}
