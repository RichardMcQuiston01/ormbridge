import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'audit_entry', timestamps: true, underscored: true })
export class AuditEntry extends Model<
  InferAttributes<AuditEntry>,
  InferCreationAttributes<AuditEntry>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  declare action: string;

  @Attribute(DataTypes.ENUM('info', 'warn'))
  @Default('info')
  declare level: CreationOptional<'info' | 'warn' | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  declare loggedAt: Date;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
