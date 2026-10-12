import {
  DataTypes,
  Model,
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

  static initModel(sequelize: Sequelize): typeof DocumentSummary {
    DocumentSummary.init(
      {
        id: { type: DataTypes.STRING, primaryKey: true, unique: true },
        title: { type: DataTypes.TEXT, allowNull: false },
      },
      {
        sequelize,
        modelName: 'DocumentSummary',
        tableName: 'DocumentSummary',
        schema: 'audit',
        timestamps: false,
      }
    );
    return DocumentSummary;
  }
}
