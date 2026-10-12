import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class DocumentSummary extends Model<
  InferAttributes<DocumentSummary>,
  InferCreationAttributes<DocumentSummary>
> {
  declare id: string;
  declare title: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof DocumentSummary {
    DocumentSummary.init(
      {
        id: { type: DataTypes.STRING, primaryKey: true, unique: true },
        title: { type: DataTypes.TEXT, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'DocumentSummary',
        tableName: 'document_summary',
        schema: 'audit',
        timestamps: true,
        underscored: true,
      }
    );
    return DocumentSummary;
  }
}
